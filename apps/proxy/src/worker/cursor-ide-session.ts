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
} from "../common/cursor-ide.js";

interface Snapshot {
  id: string;
  messages: string[];
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

const snapshotExpression = `(() => {
  ${scopeDeclaration}
  if (!bar || !input || !id) return null;
  const run = bar.querySelector('.ui-shell-tool-call__approval-row button.ui-shell-tool-call__run-btn');
  const approval = run?.closest('.ui-shell-tool-call') || run?.closest('.ui-shell-tool-call__approval-row');
  return {
    id,
    messages: [...bar.querySelectorAll('.agent-transcript-row-markdown .markdown-root, [data-flat-index] .markdown-root')].map(e => e.innerText || e.textContent || ''),
    busy: !!bar.querySelector('button.ui-prompt-input-submit-button[data-state="stop"], button[aria-label="Stop generation"]'),
    draft: (input?.innerText || input?.textContent || '').trim(),
    approval: approval ? (approval.innerText || approval.textContent || '').trim().slice(0, 4000) : null,
  };
})()`;

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

  private async selectChat(want: string): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new CursorIdeError("Cursor IDE 未连接");
    const outcome = await connection.evaluate<
      "active" | "clicked" | "occupied" | "missing"
    >(`(() => {
      const want = ${JSON.stringify(want)};
      ${scopeDeclaration}
      if (id === want) return 'active';
      if (bar && input && ((input.innerText || input.textContent || '').trim() ||
          bar.querySelector('button.ui-prompt-input-submit-button[data-state="stop"], button[aria-label="Stop generation"], .ui-shell-tool-call__approval-row button.ui-shell-tool-call__run-btn'))) return 'occupied';
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
        "当前 Cursor 会话正在生成、有待处理审批或未发送的草稿；请先处理后重试",
      );
    if (outcome === "missing")
      throw new CursorIdeError("Cursor 侧边栏中已找不到此会话，请刷新列表后重试");
    if (outcome !== "active" && outcome !== "clicked")
      throw new CursorIdeError("无法在 Cursor 中打开该会话，请重试");
  }

  private async snapshot(): Promise<Snapshot | null> {
    if (!this.connection) throw new CursorIdeError("Cursor IDE 未连接");
    return this.connection.evaluate<Snapshot | null>(snapshotExpression);
  }

  private async watchIde(): Promise<void> {
    if (this.active || this.inspecting || this.stopped) return;
    this.inspecting = true;
    try {
      const state = await this.snapshot();
      if (this.active || this.stopped) return;
      if (!state || state.id !== this.nativeId) {
        this.lastSnapshot = null;
        return;
      }
      const previous = this.lastSnapshot;
      this.lastSnapshot = state;
      const stablePrefix =
        previous && previous.messages.every((text, i) => state.messages[i]?.startsWith(text));
      const newOutput =
        stablePrefix &&
        (state.messages.length > previous.messages.length ||
          state.messages.some((text, i) => text.length > (previous.messages[i]?.length ?? 0)));
      if (!state.busy && !state.approval && !newOutput) return;
      this.active = true;
      this.interrupted = false;
      this.options.onPromptStart();
      void this.observeTurn(
        previous && stablePrefix ? previous : state,
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
    if (!before || before.id !== this.nativeId) {
      await this.selectChat(this.nativeId);
      for (let attempt = 0; attempt < 30; attempt++) {
        before = await this.snapshot();
        if (before?.id === this.nativeId) break;
        await sleep(200);
      }
    }
    if (!before || before.id !== this.nativeId)
      throw new CursorIdeError("Cursor 未能打开目标会话，请刷新列表后重试");
    if (before.draft) throw new CursorIdeError("Cursor 输入框有未发送的草稿，请先处理草稿");
    if (before.busy) throw new CursorIdeError("Cursor IDE 正在生成，请等待当前任务结束");
    // Validate the visible identity and insert in one renderer task, so a user switching
    // windows between two CDP requests cannot redirect the text to another input.
    const inserted = await connection.evaluate<boolean>(`(() => {
      ${scopeDeclaration}
      if (!bar || id !== ${JSON.stringify(this.nativeId)}) return false;
      if (!input || (input.innerText || input.textContent || '').trim()) return false;
      input.focus();
      if (document.activeElement !== input) return false;
      return document.execCommand('insertText', false, ${JSON.stringify(content)});
    })()`);
    if (!inserted) throw new CursorIdeError("无法安全输入 Cursor IDE 消息，请检查输入框");
    let submitted = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await connection.evaluate<"sent" | "pending" | "changed">(`(() => {
      ${scopeDeclaration}
      if (!bar || id !== ${JSON.stringify(this.nativeId)}) return 'changed';
      if (!input || (input.innerText || input.textContent || '').trim() !== ${JSON.stringify(content.trim())}) return 'changed';
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
    const previous = before.messages.slice();
    let observedBusy = initiallyBusy;
    let observedOutput = false;
    let idleTicks = 0;
    const deadline = Date.now() + 30 * 60_000;
    const startDeadline = Date.now() + 30_000;
    while (!this.stopped && !this.interrupted && Date.now() < deadline) {
      await sleep(WAIT_MS);
      const state = await this.snapshot();
      if (!state || state.id !== this.nativeId)
        throw new CursorIdeError("Cursor IDE 会话已切换，无法继续同步回复");
      this.lastSnapshot = state;
      if (state.busy || state.approval) {
        observedBusy = true;
        idleTicks = 0;
      }
      if (state.approval) {
        const decision = await this.options.onApproval(state.approval);
        if (decision === "cancel" || this.stopped || this.interrupted)
          throw new CursorIdeError("Cursor IDE 审批已取消");
        const applied = await connection.evaluate<boolean>(`(() => {
          ${scopeDeclaration}
          if (!bar || id !== ${JSON.stringify(this.nativeId)}) return false;
          const run = bar?.querySelector('.ui-shell-tool-call__approval-row button.ui-shell-tool-call__run-btn');
          const approval = run?.closest('.ui-shell-tool-call') || run?.closest('.ui-shell-tool-call__approval-row');
          if (!approval || (approval.innerText || approval.textContent || '').trim().slice(0, 4000) !== ${JSON.stringify(state.approval)}) return false;
          const button = ${JSON.stringify(decision)} === 'allow' ? run : approval.querySelector('button.ui-shell-tool-call__skip-btn');
          if (!button || button.disabled) return false;
          button.click(); return true;
        })()`);
        if (!applied) throw new CursorIdeError("Cursor IDE 审批状态已变化，请在 IDE 中检查");
        continue;
      }
      for (let i = 0; i < state.messages.length; i++) {
        const old = previous[i] ?? "";
        const text = state.messages[i];
        if (i < before.messages.length && old === text) continue;
        if (!text.startsWith(old))
          throw new CursorIdeError("Cursor IDE 消息视图已变化，无法可靠同步回复");
        const delta = text.slice(old.length);
        if (delta) {
          observedOutput = true;
          this.options.onUpdate({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: delta },
            },
          });
        }
        previous[i] = text;
      }
      if ((observedBusy || observedOutput) && !state.busy && ++idleTicks >= 3) {
        this.options.onPromptComplete({ stopReason: "end_turn" });
        return;
      }
      if (!observedBusy && Date.now() >= startDeadline)
        throw new CursorIdeError("Cursor IDE 未显示生成状态，请检查 IDE 会话");
    }
    if (!this.interrupted && !this.stopped) throw new CursorIdeError("等待 Cursor IDE 回复超时");
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (!this.active || !this.connection) return false;
    const clicked = await this.connection.evaluate<boolean>(`(() => {
      ${scopeDeclaration}
      if (!bar || id !== ${JSON.stringify(this.nativeId)}) return false;
      const stop = bar?.querySelector('button.ui-prompt-input-submit-button[data-state="stop"], button[aria-label="Stop generation"]');
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
