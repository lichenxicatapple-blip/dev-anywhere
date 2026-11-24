import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CursorIdeConnection,
  CursorIdeError,
  cursorIdeTargets,
  type CursorIdeTarget,
} from "../common/cursor-ide-cdp.js";
import {
  cursorIdeNativeId,
  cursorIdeUserDir,
  CURSOR_IDE_HISTORY_PREFIX,
  CURSOR_TASK_RESULT_PROMPTS,
} from "../common/cursor-ide.js";

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  /** Stable Cursor row id. Absent on the older unvirtualized transcript. */
  id?: string;
  /** Virtual-list index. Lower indexes are older rows. */
  index?: number;
}
interface TranscriptSync {
  sent: Map<string, string>;
  highWater: number;
}
export interface CursorIdeTranscriptDelta {
  role: "user" | "assistant";
  messageId: string;
  text: string;
}
interface Snapshot {
  id: string;
  messages: TranscriptEntry[];
  /** False when this composer is mounted but is not the chat Cursor is showing. */
  visible?: boolean;
  busy: boolean;
  draft: string;
  approval: string | null;
}
interface Options {
  cwd: string;
  resumeSessionId?: string;
  onUpdate: (params: Record<string, unknown>) => void;
  onPromptStart: () => void;
  onPromptComplete: (result: { stopReason: string }) => void;
  onPromptError: (error: Error) => void;
  onApproval: (description: string) => Promise<"allow" | "deny" | "cancel">;
  onExit: (code: number) => void;
}

const WAIT_MS = 400;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

async function hasUniqueWorkspacePath(cwd: string): Promise<boolean> {
  const root = join(cursorIdeUserDir(), "workspaceStorage");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const json = JSON.parse(await readFile(join(root, entry.name, "workspace.json"), "utf8")) as {
        folder?: unknown;
      };
      if (typeof json.folder !== "string") continue;
      const path = resolve(fileURLToPath(json.folder));
      if (basename(path) === basename(cwd)) paths.add(path);
    } catch {
      /* Skip non-local and malformed workspaces. */
    }
  }
  return paths.size === 1 && paths.has(resolve(cwd));
}

// The editor uses a composer bar; the separate Agents window identifies the input directly.
// Every mutation rechecks this identity in the same renderer task as the action.
const scopeDeclaration = `
  const bars = [...document.querySelectorAll('.composer-bar[data-composer-id]')].filter(e => e.getBoundingClientRect().width > 0);
  const agents = [...document.querySelectorAll('[data-sidebar-file-drop-editor-agent-id][contenteditable="true"]')].filter(e => e.getBoundingClientRect().width > 0);
  const selectedRows = [...document.querySelectorAll('[data-perf-id="glass-sidebar-agent-row"][data-active="true"]')];
  const selectedId = selectedRows.length === 1 ? selectedRows[0].getAttribute('data-sidebar-file-drop-agent-id') : null;
  const selectedAgents = selectedId ? agents.filter(e => e.getAttribute('data-sidebar-file-drop-editor-agent-id') === selectedId) : agents;
  let bar, input, id;
  if (bars.length === 1 && agents.length === 0) {
    bar = bars[0];
    input = bar.querySelector('[contenteditable="true"][role="textbox"], [contenteditable="true"]');
    id = bar.getAttribute('data-composer-id');
  } else if (bars.length === 0 && selectedAgents.length === 1) {
    input = selectedAgents[0];
    bar = input.closest('.agent-panel-conversation-shell');
    id = input.getAttribute('data-sidebar-file-drop-editor-agent-id');
  }
`;

// Human bubbles and the in-progress plan are not assistant markdown. Read them too,
// and remember whether this composer is the one Cursor is actually showing.
const readOpenPanel = `
  if (!bar || !id) return null;
  const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
  const injectedTaskPrompt = (value) => ${JSON.stringify(CURSOR_TASK_RESULT_PROMPTS)}.includes(value.replace(/\\s+/g, ' ').trim());
  const messages = [];
  const seen = new Set();
  const idRows = [...bar.querySelectorAll('[data-message-id][data-message-kind="human"], [data-message-id][data-message-kind="assistant"]')];
  if (idRows.length) {
    for (const row of idRows) {
      const messageId = row.getAttribute('data-message-id');
      if (!messageId || seen.has(messageId)) continue;
      seen.add(messageId);
      const virtual = row.closest('[data-index]');
      const parsedIndex = virtual ? Number(virtual.getAttribute('data-index')) : -1;
      const index = Number.isFinite(parsedIndex) ? parsedIndex : -1;
      if (row.getAttribute('data-message-kind') === 'human') {
        const bubble = row.querySelector('[data-agent-transcript-human-bubble], .ui-agent-transcript-human-bubble, .composer-human-message-content') || row;
        const text = textOf(bubble);
        if (text && !injectedTaskPrompt(text)) messages.push({ id: messageId, role: 'user', text, index });
        continue;
      }
      const markdown = row.querySelector('.markdown-root');
      const plan = row.querySelector('.plan-editor__richtext-content, .plan-body');
      const text = textOf(markdown) || textOf(plan);
      if (text) messages.push({ id: messageId, role: 'assistant', text, index });
    }
    let planIndex = messages.reduce((max, entry) => Math.max(max, entry.index), -1) + 1;
    for (const node of bar.querySelectorAll('.plan-editor__richtext-content, .plan-body')) {
      if (node.closest('[data-message-id]')) continue;
      const text = textOf(node);
      if (text) messages.push({ id: 'plan:open', role: 'assistant', text, index: planIndex++ });
    }
  } else {
    const nodes = [...bar.querySelectorAll('[data-message-kind="human"], [data-message-kind="assistant"] .markdown-root, .agent-transcript-row-markdown .markdown-root, .plan-editor__richtext-content, .plan-body')];
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.matches('[data-message-kind="human"]')) {
        const bubble = node.querySelector('[data-agent-transcript-human-bubble], .ui-agent-transcript-human-bubble, .composer-human-message-content') || node;
        const text = textOf(bubble);
        if (text && !injectedTaskPrompt(text)) messages.push({ role: 'user', text });
        continue;
      }
      if (node.matches('.plan-editor__richtext-content, .plan-body')) {
        const holder = node.closest('[data-message-kind="assistant"], .agent-transcript-row-markdown');
        const markdown = holder && holder.querySelector('.markdown-root');
        if (markdown && textOf(markdown)) continue;
        const text = textOf(node);
        if (text) messages.push({ role: 'assistant', text });
        continue;
      }
      const text = textOf(node);
      if (text) messages.push({ role: 'assistant', text });
    }
  }
  const activeRow = document.querySelector('[data-perf-id="glass-sidebar-agent-row"][data-active="true"]');
  const activeId = activeRow ? activeRow.getAttribute('data-sidebar-file-drop-agent-id') : null;
  const visibleBars = [...document.querySelectorAll('.composer-bar[data-composer-id]')].filter((entry) => entry.getBoundingClientRect().width > 0);
  const visible = activeId ? activeId === id : visibleBars.length === 1 && visibleBars[0].getAttribute('data-composer-id') === id;
  const run = bar.querySelector('.ui-shell-tool-call__approval-row button.ui-shell-tool-call__run-btn');
  const approvalNode = run?.closest('.ui-shell-tool-call') || run?.closest('.ui-shell-tool-call__approval-row');
  const status = (bar.getAttribute('data-composer-status') || '').toLowerCase();
  return {
    id,
    messages,
    visible,
    busy: !!bar.querySelector('button.ui-prompt-input-submit-button[data-state="stop"], button[aria-label="Stop generation"]') || /^(generating|running|in_progress|applying)$/.test(status),
    draft: textOf(input),
    approval: approvalNode ? textOf(approvalNode).slice(0, 4000) : null,
  };
`;

const snapshotExpression = `(() => {
  ${scopeDeclaration}
  ${readOpenPanel}
})()`;

function pinnedComposerLookup(composerId: string): string {
  const want = JSON.stringify(composerId);
  return `
    const want = ${want};
    const bars = [...document.querySelectorAll('.composer-bar[data-composer-id]')].filter((entry) => entry.getAttribute('data-composer-id') === want);
    const agentInputs = [...document.querySelectorAll('[data-sidebar-file-drop-editor-agent-id][contenteditable="true"]')].filter((entry) => entry.getAttribute('data-sidebar-file-drop-editor-agent-id') === want);
    let bar = null, input = null;
    if (bars.length >= 1) {
      bar = bars[0];
      input = bar.querySelector('[contenteditable="true"][role="textbox"], [contenteditable="true"]');
    } else if (agentInputs.length >= 1) {
      input = agentInputs[0];
      bar = input.closest('.agent-panel-conversation-shell') || input.parentElement;
    }
  `;
}

function pinnedSnapshotExpression(composerId: string): string {
  return `(() => {
    ${pinnedComposerLookup(composerId)}
    const id = input ? want : null;
    ${readOpenPanel}
  })()`;
}

// execCommand only inserts when the caret is inside the editor. The Agents input
// accepts that directly; the Lexical composer often refuses it, so write its state
// and only report success once the visible text matches.
function insertComposerText(content: string): string {
  const value = JSON.stringify(content);
  return `
    const value = ${value};
    const read = () => ((input.innerText || input.textContent) || '').trim();
    if (!input || read()) return false;
    input.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch (error) {}
    let accepted = false;
    try { accepted = document.execCommand('insertText', false, value) === true; } catch (error) { accepted = false; }
    if (accepted) return true;
    const lexical = input.__lexicalEditor;
    if (lexical && typeof lexical.parseEditorState === 'function' && typeof lexical.setEditorState === 'function') {
      try {
        const textNode = { detail: 0, format: 0, mode: 'normal', style: '', text: value, type: 'text', version: 1 };
        const paragraph = { children: [textNode], direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1 };
        const root = { children: [paragraph], direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 };
        lexical.setEditorState(lexical.parseEditorState(JSON.stringify({ root })));
      } catch (error) {}
    }
    if (read() === value.trim()) return true;
    const view = input.pmViewDesc && input.pmViewDesc.view;
    if (view && view.state && view.state.tr && typeof view.state.tr.insertText === 'function' && typeof view.dispatch === 'function') {
      try { view.dispatch(view.state.tr.insertText(value)); } catch (error) {}
    }
    return read() === value.trim();
  `;
}

function asTranscriptEntry(value: TranscriptEntry | string): TranscriptEntry {
  if (typeof value === "string") return { role: "assistant", text: value };
  const index = typeof value.index === "number" && Number.isFinite(value.index) ? value.index : undefined;
  return {
    role: value.role === "user" ? "user" : "assistant",
    text: typeof value.text === "string" ? value.text : "",
    ...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
    ...(index === undefined ? {} : { index }),
  };
}

function entryExtends(previous: TranscriptEntry, next: TranscriptEntry | undefined): boolean {
  return !!next && next.role === previous.role && next.text.startsWith(previous.text);
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, "");
}

function joinRole(messages: TranscriptEntry[], role: TranscriptEntry["role"]): string {
  return messages
    .filter((entry) => entry.role === role)
    .map((entry) => entry.text)
    .join("");
}

/** Longest prefix of `visible` that is a suffix of `sent`. */
function longestSuffixPrefix(sent: string, visible: string): number {
  if (!sent || !visible) return 0;
  const border = new Array<number>(visible.length).fill(0);
  let matched = 0;
  for (let i = 1; i < visible.length; i++) {
    while (matched > 0 && visible[i] !== visible[matched]) matched = border[matched - 1] ?? 0;
    if (visible[i] === visible[matched]) matched += 1;
    border[i] = matched;
  }
  matched = 0;
  for (let i = 0; i < sent.length; i++) {
    while (matched > 0 && sent[i] !== visible[matched]) matched = border[matched - 1] ?? 0;
    if (sent[i] !== visible[matched]) continue;
    matched += 1;
    if (matched === visible.length) {
      if (i === sent.length - 1) return matched;
      matched = border[matched - 1] ?? 0;
    }
  }
  return matched;
}

/**
 * Text in the current view that has not been sent yet.
 * A virtualized window can drop the prefix or split one bubble; that is still the same reply.
 */
export function unsyncedTranscriptSuffix(sent: string, visible: string): string {
  if (!visible) return "";
  const normSent = normalizeTranscript(sent);
  const normVisible = normalizeTranscript(visible);
  if (normVisible.startsWith(normSent)) {
    let seen = 0;
    let index = 0;
    while (index < visible.length && seen < normSent.length) {
      if (!/\s/.test(visible[index] ?? "")) seen += 1;
      index += 1;
    }
    return visible.slice(index);
  }
  if (normSent.includes(normVisible)) return "";
  const overlap = longestSuffixPrefix(sent, visible);
  return overlap > 0 ? visible.slice(overlap) : visible;
}

/** Index alignment used to abort when Cursor scrolled or split a bubble. Realign the visible text. */
export function diffUnkeyedTranscript(
  emitted: { user: string; assistant: string },
  messages: TranscriptEntry[],
): CursorIdeTranscriptDelta[] {
  const deltas: CursorIdeTranscriptDelta[] = [];
  for (const role of ["user", "assistant"] as const) {
    const rows = messages.flatMap((entry, index) => (entry.role === role ? [{ entry, index }] : []));
    const text = unsyncedTranscriptSuffix(emitted[role], rows.map((row) => row.entry.text).join(""));
    if (!text) continue;
    const index = rows[rows.length - 1]?.index ?? 0;
    deltas.push({
      role,
      messageId: role === "user" ? `ide-echo-${index}` : "",
      text,
    });
  }
  return deltas;
}

function seedTranscriptSync(messages: TranscriptEntry[]): TranscriptSync {
  const sent = new Map<string, string>();
  let highWater = -1;
  for (const entry of messages) {
    if (entry.id) sent.set(entry.id, entry.text);
    if (typeof entry.index === "number" && entry.index > highWater) highWater = entry.index;
  }
  return { sent, highWater };
}

function keyedTranscript(messages: TranscriptEntry[]): boolean {
  return messages.every((entry) => !!entry.id);
}

/** True when a virtual row grew, or a row newer than the previous window appeared. */
function hasKeyedGrowth(previous: TranscriptEntry[], next: TranscriptEntry[]): boolean {
  const sent = new Map(previous.flatMap((entry) => (entry.id ? [[entry.id, entry.text] as const] : [])));
  const highWater = previous.reduce((max, entry) => Math.max(max, entry.index ?? -1), -1);
  return next.some((entry) => {
    if (!entry.id) return false;
    const known = sent.get(entry.id);
    if (known === undefined) return (entry.index ?? -1) < 0 || entry.index > highWater;
    return entry.text.startsWith(known) && entry.text.length > known.length;
  });
}

function assistantRunAlreadyShows(sync: TranscriptSync, messages: TranscriptEntry[], index: number): boolean {
  const entry = messages[index];
  if (!entry || entry.role !== "assistant") return false;
  const norm = normalizeTranscript(entry.text);
  if (!norm) return true;
  let sawSplit = false;
  let covered = "";
  for (let i = index - 1; i >= 0 && messages[i]?.role === "assistant"; i--) {
    const earlier = messages[i];
    if (!earlier?.id) continue;
    const sentText = sync.sent.get(earlier.id) ?? "";
    if (sentText.length > earlier.text.length && sentText.startsWith(earlier.text)) sawSplit = true;
    covered = sentText + covered;
  }
  return sawSplit && normalizeTranscript(covered).includes(norm);
}

function consumeSplitRemainder(sync: TranscriptSync, messages: TranscriptEntry[]): void {
  const laterNorm = messages
    .filter((entry) => entry.role === "assistant")
    .map((entry) => normalizeTranscript(entry.text))
    .join("");
  for (const entry of messages) {
    if (!entry.id || entry.role !== "assistant") continue;
    const known = sync.sent.get(entry.id);
    if (!known || known.length <= entry.text.length || !known.startsWith(entry.text)) continue;
    const remainder = normalizeTranscript(known.slice(entry.text.length));
    if (!remainder || laterNorm.includes(remainder)) sync.sent.set(entry.id, entry.text);
  }
}

/**
 * Cursor virtualizes the transcript and splits one reply into several bubbles.
 * Index alignment treats that as a different view and aborts the turn. Follow row
 * ids instead, and don't send text that was already shown before the split.
 * Returns null when the DOM has no row ids, so the caller realigns the visible text.
 */
export function diffCursorIdeTranscript(
  sync: TranscriptSync,
  next: TranscriptEntry[],
): CursorIdeTranscriptDelta[] | null {
  if (next.some((entry) => !entry.id)) return null;
  const deltas: CursorIdeTranscriptDelta[] = [];
  for (let i = 0; i < next.length; i++) {
    const entry = next[i];
    if (!entry?.id) continue;
    const known = sync.sent.get(entry.id);
    const historical =
      known === undefined &&
      typeof entry.index === "number" &&
      entry.index >= 0 &&
      entry.index <= sync.highWater;
    if (typeof entry.index === "number" && entry.index > sync.highWater) sync.highWater = entry.index;
    if (known === undefined) {
      const covered = entry.role === "assistant" && assistantRunAlreadyShows(sync, next, i);
      const text = historical || covered ? "" : entry.text;
      sync.sent.set(entry.id, entry.text);
      if (text) {
        deltas.push({
          role: entry.role,
          messageId: entry.role === "user" ? `ide-echo-${entry.id}` : "",
          text,
        });
      }
      continue;
    }
    if (entry.text === known || known.startsWith(entry.text)) continue;
    if (entry.text.startsWith(known)) {
      const text = entry.text.slice(known.length);
      sync.sent.set(entry.id, entry.text);
      if (text) {
        deltas.push({
          role: entry.role,
          messageId: entry.role === "user" ? `ide-echo-${entry.id}` : "",
          text,
        });
      }
      continue;
    }
    if (entry.role === "assistant" && assistantRunAlreadyShows(sync, next, i)) continue;
    sync.sent.set(entry.id, entry.text);
    deltas.push({
      role: entry.role,
      messageId: entry.role === "user" ? `ide-echo-${entry.id}` : "",
      text: entry.text,
    });
  }
  consumeSplitRemainder(sync, next);
  return deltas;
}

export class CursorIdeSession {
  private connection: CursorIdeConnection | undefined;
  private ready: Promise<string> | undefined;
  private nativeId = "";
  private active = false;
  private readonly queuedMessages: string[] = [];
  private lastSnapshot: Snapshot | null = null;
  private watcher: NodeJS.Timeout | undefined;
  private inspecting = false;
  private stopped = false;
  private interrupted = false;
  private errorTail = "";
  constructor(private readonly options: Options) {}

  start(): number {
    this.ready = this.initialize();
    return process.pid;
  }
  waitUntilReady(): Promise<string> {
    if (!this.ready) throw new Error("Cursor IDE session has not started");
    return this.ready;
  }
  getStderr(): string {
    return this.errorTail;
  }

  private async initialize(): Promise<string> {
    const id = this.options.resumeSessionId
      ? cursorIdeNativeId(this.options.resumeSessionId)
      : null;
    if (this.options.resumeSessionId && !id) throw new CursorIdeError("无效的 Cursor IDE 会话 ID");
    const windows = await cursorIdeTargets();
    const matches: Array<{
      connection: CursorIdeConnection;
      target: CursorIdeTarget;
      sidebar?: boolean;
    }> = [];
    if (id) {
      for (const target of windows) {
        const connection = await CursorIdeConnection.connect(target.webSocketDebuggerUrl);
        try {
          const found = await connection.evaluate<{
            sidebar: boolean;
            active: boolean;
            tab: boolean;
          }>(`(() => {
            const want = ${JSON.stringify(id)};
            ${scopeDeclaration}
            const rows = [...document.querySelectorAll('[data-perf-id="glass-sidebar-agent-row"][data-sidebar-file-drop-agent-id]')].filter(e => e.getAttribute('data-sidebar-file-drop-agent-id') === want);
            const tabs = [...document.querySelectorAll('[role="tab"][data-resource-name]')].filter(e => {
              const value = e.getAttribute('data-resource-name') || '';
              return value === want || (value.length >= 32 && want.startsWith(value));
            });
            return { sidebar: rows.length === 1, active: id === want, tab: tabs.length === 1 };
          })()`);
          if (found?.sidebar || found?.active || found?.tab)
            matches.push({ connection, target, sidebar: found.sidebar });
          else connection.close();
        } catch (error) {
          connection.close();
          matches.forEach((match) => match.connection.close());
          throw error;
        }
      }
      // Prefer the actual Agents sidebar over a second editor window showing the same chat.
      const sidebarMatches = matches.filter((match) => match.sidebar);
      if (sidebarMatches.length === 1) {
        for (const match of matches) if (match !== sidebarMatches[0]) match.connection.close();
        matches.splice(0, matches.length, sidebarMatches[0]);
      }
    } else {
      if (!(await hasUniqueWorkspacePath(this.options.cwd))) {
        throw new CursorIdeError("无法唯一确认 Cursor IDE 工作区，请先在 Cursor 打开该目录");
      }
      const name = basename(resolve(this.options.cwd));
      const candidates = windows.filter(
        (target) =>
          target.title === name ||
          target.title.endsWith(` — ${name}`) ||
          target.title.endsWith(` - ${name}`),
      );
      for (const target of candidates)
        matches.push({
          connection: await CursorIdeConnection.connect(target.webSocketDebuggerUrl),
          target,
        });
    }
    if (matches.length !== 1) {
      matches.forEach(({ connection }) => connection.close());
      throw new CursorIdeError(
        id
          ? "未能唯一找到该 Cursor 会话，请刷新列表并确认 Cursor 窗口已打开"
          : "未能唯一找到该工作区的 Cursor IDE 窗口",
      );
    }
    this.connection = matches[0].connection;
    const originalId = (await this.snapshot())?.id;
    if (id) {
      await this.selectChat(id);
    } else {
      const clicked = await this.connection.evaluate<boolean>(`(() => {
        const buttons = [...document.querySelectorAll('a[aria-label^="New Agent"], [data-command-id="composer.createNewComposerTab"]')].filter(e => e.getBoundingClientRect().width > 0);
        if (buttons.length !== 1) return false;
        buttons[0].click(); return true;
      })()`);
      if (!clicked) throw new CursorIdeError("未找到 Cursor IDE 的新建会话按钮，请先打开聊天面板");
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      const snapshot = await this.snapshot();
      if (
        snapshot &&
        UUID.test(snapshot.id) &&
        (id ? snapshot.id === id : snapshot.id !== originalId)
      ) {
        this.nativeId = snapshot.id;
        this.lastSnapshot = snapshot;
        this.watcher = setInterval(() => void this.watchIde(), WAIT_MS);
        this.watcher.unref?.();
        return `${CURSOR_IDE_HISTORY_PREFIX}${snapshot.id}`;
      }
      await sleep(200);
    }
    throw new CursorIdeError("Cursor 未能打开目标会话，请确认会话仍在侧边栏后重试");
  }

  private showingTarget(snapshot: Snapshot | null): snapshot is Snapshot {
    return !!snapshot && snapshot.id === this.nativeId && snapshot.visible !== false;
  }

  private async selectChat(want: string): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new CursorIdeError("Cursor IDE 未连接");
    const outcome = await connection.evaluate<
      "active" | "clicked" | "occupied" | "missing"
    >(`(() => {
      const want = ${JSON.stringify(want)};
      ${scopeDeclaration}
      if (id === want) return 'active';
      // A generating chat can stay in the background. Only an unsent draft or a pending
      // approval has to be handled before the view moves.
      if (bar && input && ((input.innerText || input.textContent || '').trim() ||
          bar.querySelector('.ui-shell-tool-call__approval-row button.ui-shell-tool-call__run-btn'))) return 'occupied';
      const rows = [...document.querySelectorAll('[data-perf-id="glass-sidebar-agent-row"][data-sidebar-file-drop-agent-id]')].filter(e => e.getAttribute('data-sidebar-file-drop-agent-id') === want);
      const tabs = [...document.querySelectorAll('[role="tab"][data-resource-name]')].filter(e => {
        const value = e.getAttribute('data-resource-name') || '';
        return value === want || (value.length >= 32 && want.startsWith(value));
      });
      const target = rows.length === 1 ? (rows[0].querySelector('[data-sidebar-row-trigger]') || rows[0]) : tabs.length === 1 ? tabs[0] : null;
      if (!target) return 'missing';
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      target.click();
      return 'clicked';
    })()`);
    if (outcome === "occupied")
      throw new CursorIdeError(
        "当前 Cursor 会话有待处理审批或未发送的草稿；请先处理后重试",
      );
    if (outcome === "missing")
      throw new CursorIdeError("Cursor 侧边栏中已找不到此会话，请刷新列表后重试");
    if (outcome !== "active" && outcome !== "clicked")
      throw new CursorIdeError("无法在 Cursor 中打开该会话，请重试");
  }

  private async snapshot(targetId = this.nativeId): Promise<Snapshot | null> {
    if (!this.connection) throw new CursorIdeError("Cursor IDE 未连接");
    const expression = targetId ? pinnedSnapshotExpression(targetId) : snapshotExpression;
    const snapshot = await this.connection.evaluate<
      (Omit<Snapshot, "messages"> & { messages?: Array<TranscriptEntry | string> }) | null
    >(expression);
    if (!snapshot?.id) return null;
    return {
      ...snapshot,
      messages: (snapshot.messages ?? []).map((entry) => asTranscriptEntry(entry)),
    };
  }

  private async watchIde(): Promise<void> {
    if (this.active || this.inspecting || this.stopped) return;
    this.inspecting = true;
    try {
      const state = await this.snapshot();
      if (this.active || this.stopped) return;
      // Another visible chat is not this session. Keep the last baseline and keep polling
      // the pinned composer; clearing it is what made a still-running turn look idle.
      if (!state || state.id !== this.nativeId) return;
      const previous = this.lastSnapshot;
      this.lastSnapshot = state;
      const keyed =
        !!previous &&
        keyedTranscript(previous.messages) &&
        keyedTranscript(state.messages);
      const stablePrefix =
        !!previous &&
        previous.messages.every((entry, index) => entryExtends(entry, state.messages[index]));
      const newOutput = keyed
        ? hasKeyedGrowth(previous.messages, state.messages)
        : stablePrefix &&
          (state.messages.length > previous.messages.length ||
            state.messages.some(
              (entry, index) => entry.text.length > (previous.messages[index]?.text.length ?? 0),
            ));
      if (!state.busy && !state.approval && !newOutput) return;
      this.active = true;
      this.interrupted = false;
      this.options.onPromptStart();
      // A virtual window shift is not a new baseline. Keep the previous row ids so the
      // text that scrolled into view can still be diffed instead of dropped.
      void this.observeTurn(
        previous && (keyed || stablePrefix) ? previous : state,
        state.busy || !!state.approval,
      )
        .catch((error: unknown) => this.reportPromptError(error))
        .finally(() => this.finishPrompt());
    } catch (error) {
      if (this.stopped) return;
      this.errorTail = error instanceof Error ? error.message : String(error);
      this.stopped = true;
      if (this.watcher) clearInterval(this.watcher);
      this.connection?.close();
      this.options.onExit(1);
    } finally {
      this.inspecting = false;
    }
  }

  private reportPromptError(error: unknown): void {
    if (this.interrupted || this.stopped) return;
    const err = error instanceof Error ? error : new Error(String(error));
    this.errorTail = err.message;
    this.options.onPromptError(err);
  }

  private finishPrompt(): void {
    this.active = false;
    const next = this.queuedMessages.shift();
    if (next !== undefined && !this.stopped) this.sendMessage(next);
  }

  sendMessage(content: string): void {
    if (this.active) {
      this.queuedMessages.push(content);
      return;
    }
    this.active = true;
    this.interrupted = false;
    void this.runPrompt(content)
      .catch((error: unknown) => this.reportPromptError(error))
      .finally(() => this.finishPrompt());
  }

  private async runPrompt(content: string): Promise<void> {
    if (!content.trim()) throw new CursorIdeError("消息不能为空");
    const connection = this.connection;
    if (!connection) throw new CursorIdeError("Cursor IDE 未连接");
    let before = await this.snapshot();
    // A mounted background panel still has this composer's id. Typing uses the chat
    // Cursor is showing, so switch back before inserting instead of rejecting the box.
    if (!this.showingTarget(before)) {
      await this.selectChat(this.nativeId);
      for (let attempt = 0; attempt < 30; attempt++) {
        before = await this.snapshot();
        if (this.showingTarget(before)) break;
        await sleep(200);
      }
    }
    if (!this.showingTarget(before))
      throw new CursorIdeError("Cursor 未能打开目标会话，请刷新列表后重试");
    if (before.draft) throw new CursorIdeError("Cursor 输入框有未发送的草稿，请先处理草稿");
    if (before.busy) throw new CursorIdeError("Cursor IDE 正在生成，请等待当前任务结束");
    // Bind the composer by id in the same renderer task as the write. The visible-scope
    // lookup stays unset when an editor bar and an Agents input are both on screen.
    const inserted = await connection.evaluate<boolean>(`(() => {
      ${pinnedComposerLookup(this.nativeId)}
      ${insertComposerText(content)}
    })()`);
    if (!inserted) throw new CursorIdeError("无法安全输入 Cursor IDE 消息，请检查输入框");
    let submitted = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await connection.evaluate<"sent" | "pending" | "changed">(`(() => {
      ${pinnedComposerLookup(this.nativeId)}
      if (!bar || !input) return 'changed';
      const current = ((input.innerText || input.textContent) || '').trim();
      const expected = ${JSON.stringify(content.trim())};
      if (current !== expected) return current ? 'changed' : 'pending';
      const button = bar.querySelector('button.ui-prompt-input-submit-button[aria-label="Send message"], button[aria-label="Send message"]');
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return 'pending';
      button.click(); return 'sent';
    })()`);
      if (result === "sent") {
        submitted = true;
        break;
      }
      if (result !== "pending") break;
      await sleep(100);
    }
    if (!submitted) throw new CursorIdeError("Cursor IDE 未确认发送；请检查输入框中的草稿");
    this.options.onPromptStart();
    await this.observeTurn(before, false);
  }

  private async observeTurn(before: Snapshot, initiallyBusy: boolean): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new CursorIdeError("Cursor IDE 未连接");
    const sync = seedTranscriptSync(before.messages);
    const emitted = {
      user: joinRole(before.messages, "user"),
      assistant: joinRole(before.messages, "assistant"),
    };
    let observedBusy = initiallyBusy;
    let observedOutput = false;
    let idleTicks = 0;
    const deadline = Date.now() + 30 * 60_000;
    const startDeadline = Date.now() + 30_000;
    while (!this.stopped && !this.interrupted && Date.now() < deadline) {
      await sleep(WAIT_MS);
      const state = await this.snapshot();
      // The composer can keep generating after Cursor shows a different chat. Losing the
      // panel is not an idle transition, and it must not finish the turn.
      if (!state || state.id !== this.nativeId) {
        if (Date.now() >= deadline) throw new CursorIdeError("等待 Cursor IDE 回复超时");
        continue;
      }
      const detached = state.visible === false;
      this.lastSnapshot = state;
      if (state.busy || state.approval || detached) {
        observedBusy = true;
        idleTicks = 0;
      }
      if (state.approval) {
        const decision = await this.options.onApproval(state.approval);
        if (decision === "cancel" || this.stopped || this.interrupted)
          throw new CursorIdeError("Cursor IDE 审批已取消");
        const applied = await connection.evaluate<boolean>(`(() => {
          const want = ${JSON.stringify(this.nativeId)};
          const bars = [...document.querySelectorAll('.composer-bar[data-composer-id]')].filter((entry) => entry.getAttribute('data-composer-id') === want);
          const agentInputs = [...document.querySelectorAll('[data-sidebar-file-drop-editor-agent-id][contenteditable="true"]')].filter((entry) => entry.getAttribute('data-sidebar-file-drop-editor-agent-id') === want);
          const bar = bars[0] || (agentInputs[0] ? agentInputs[0].closest('.agent-panel-conversation-shell') || agentInputs[0].parentElement : null);
          if (!bar) return false;
          const run = bar.querySelector('.ui-shell-tool-call__approval-row button.ui-shell-tool-call__run-btn');
          const approval = run?.closest('.ui-shell-tool-call') || run?.closest('.ui-shell-tool-call__approval-row');
          if (!approval || (approval.innerText || approval.textContent || '').trim().slice(0, 4000) !== ${JSON.stringify(state.approval)}) return false;
          const button = ${JSON.stringify(decision)} === 'allow' ? run : approval.querySelector('button.ui-shell-tool-call__skip-btn');
          if (!button || button.disabled) return false;
          button.click(); return true;
        })()`);
        if (!applied) throw new CursorIdeError("Cursor IDE 审批状态已变化，请在 IDE 中检查");
        continue;
      }
      const keyedDeltas = diffCursorIdeTranscript(sync, state.messages);
      const deltas = keyedDeltas ?? diffUnkeyedTranscript(emitted, state.messages);
      for (const delta of deltas) {
        if (!delta.text) continue;
        observedOutput = true;
        emitted[delta.role] += delta.text;
        this.emitTranscriptDelta(delta);
      }
      // Row ids disappeared for one render. Keep waiting instead of aborting the reply.
      // A hidden composer has no reliable idle signal: its stop button may belong to the
      // chat that is currently on screen. Stay working until this chat is visible again.
      if (detached) continue;
      if ((observedBusy || observedOutput) && !state.busy && ++idleTicks >= 3) {
        this.options.onPromptComplete({ stopReason: "end_turn" });
        return;
      }
      if (!observedBusy && Date.now() >= startDeadline)
        throw new CursorIdeError("Cursor IDE 未显示生成状态，请检查 IDE 会话");
    }
    if (!this.interrupted && !this.stopped) throw new CursorIdeError("等待 Cursor IDE 回复超时");
  }

  private emitTranscriptDelta(delta: CursorIdeTranscriptDelta): void {
    this.options.onUpdate({
      update:
        delta.role === "user"
          ? {
              sessionUpdate: "cursor_ide_user_message",
              messageId: delta.messageId,
              content: { type: "text", text: delta.text },
            }
          : {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: delta.text },
            },
    });
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (!this.active || !this.connection) return false;
    const clicked = await this.connection.evaluate<boolean>(`(() => {
      const want = ${JSON.stringify(this.nativeId)};
      const bars = [...document.querySelectorAll('.composer-bar[data-composer-id]')].filter((entry) => entry.getAttribute('data-composer-id') === want);
      const agentInputs = [...document.querySelectorAll('[data-sidebar-file-drop-editor-agent-id][contenteditable="true"]')].filter((entry) => entry.getAttribute('data-sidebar-file-drop-editor-agent-id') === want);
      const bar = bars[0] || (agentInputs[0] ? agentInputs[0].closest('.agent-panel-conversation-shell') || agentInputs[0].parentElement : null);
      if (!bar) return false;
      const stop = bar.querySelector('button.ui-prompt-input-submit-button[data-state="stop"], button[aria-label="Stop generation"]');
      if (!stop) return false; stop.click(); return true;
    })()`);
    if (clicked) this.interrupted = true;
    return clicked;
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watcher) clearInterval(this.watcher);
    this.queuedMessages.length = 0;
    this.connection?.close();
    this.options.onExit(0);
  }
}
