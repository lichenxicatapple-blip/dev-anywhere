import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectJsonlFiles } from "./files.js";
import type { NativeHistorySession } from "./types.js";
import {
  cursorIdeNativeId,
  cursorIdeUserDir,
  CURSOR_IDE_HISTORY_PREFIX,
  isCursorTaskResultPrompt,
} from "../../common/cursor-ide.js";
import {
  listCursorIdeVisibleChats,
  type CursorIdeVisibleChat,
} from "../../common/cursor-ide-sidebar.js";
import { CursorIdeError } from "../../common/cursor-ide-cdp.js";

// A distinct identity keeps IDE sessions out of the CLI's ACP resume path.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const require = createRequire(import.meta.url);

export function cursorIdeProjectsDir(): string {
  return process.env.CURSOR_IDE_PROJECTS_DIR ?? join(homedir(), ".cursor", "projects");
}

async function transcriptFiles(root: string): Promise<string[]> {
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = await Promise.all(
    projects
      .filter((entry) => entry.isDirectory())
      .map((entry) => collectJsonlFiles(join(root, entry.name, "agent-transcripts"))),
  );
  return files.flat();
}

export async function findCursorIdeTranscript(
  id: string,
  root = cursorIdeProjectsDir(),
): Promise<string | null> {
  const nativeId = cursorIdeNativeId(id);
  if (!nativeId) return null;
  const matches = (await transcriptFiles(root)).filter(
    (file) => basename(file) === `${nativeId}.jsonl`,
  );
  // Never choose an arbitrary transcript when IDs collide.
  return matches.length === 1 ? matches[0] : null;
}

function cursorProjectSlug(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/^\/+/, "").replace(/[/: ]/g, "-");
}

async function composerWorkspaceFolder(
  userDir: string,
  composerId: string,
): Promise<string | undefined> {
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(join(userDir, "globalStorage", "state.vscdb"), { readOnly: true });
    const row = db.prepare("SELECT workspaceId FROM composerHeaders WHERE composerId = ?").get(
      composerId,
    ) as { workspaceId?: unknown } | undefined;
    const workspaceId = typeof row?.workspaceId === "string" ? row.workspaceId : undefined;
    return workspaceId ? workspacePath(userDir, workspaceId) : undefined;
  } catch {
    return;
  } finally {
    db?.close();
  }
}

/**
 * Prefer the transcript for this composer's workspace. Identical ids are copied
 * into worktrees; returning nothing there made a restored IDE session look empty.
 */
export async function resolveCursorIdeTranscript(
  id: string,
  root = cursorIdeProjectsDir(),
  userDir = cursorIdeUserDir(),
): Promise<string | null> {
  const nativeId = cursorIdeNativeId(id);
  if (!nativeId) return null;
  const matches = (await transcriptFiles(root)).filter(
    (file) => basename(file) === `${nativeId}.jsonl`,
  );
  if (matches.length <= 1) return matches[0] ?? null;
  const folder = await composerWorkspaceFolder(userDir, nativeId);
  if (folder) {
    const slug = cursorProjectSlug(folder);
    const preferred = matches.filter((file) => file.split(sep).includes(slug));
    if (preferred.length === 1) return preferred[0] ?? null;
  }
  const ranked = await Promise.all(
    matches.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })),
  );
  ranked.sort((left, right) => right.mtime - left.mtime);
  return ranked[0]?.file ?? null;
}

function visibleBubbleText(role: "user" | "assistant", raw: string): string {
  const withoutReminders = raw.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, "");
  const query = withoutReminders.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  const text = (query?.[1] ?? withoutReminders).trim();
  if (role === "user" && isCursorTaskResultPrompt(text)) return "";
  if (
    role === "user" &&
    /^<(?:user_info|timestamp|environment_context|conversation_summary)(?:[\s>:-])/i.test(text)
  ) {
    return "";
  }
  return text;
}

export interface CursorIdeBubbleMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

/** IDE chats that never flushed an agent transcript still keep their text in composer bubbles. */
export async function readCursorIdeBubbleMessages(
  id: string,
  userDir = cursorIdeUserDir(),
): Promise<CursorIdeBubbleMessage[]> {
  const nativeId = cursorIdeNativeId(id);
  if (!nativeId) return [];
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(join(userDir, "globalStorage", "state.vscdb"), { readOnly: true });
    const rows = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ?")
      .all(`bubbleId:${nativeId}:`, `bubbleId:${nativeId};`) as Array<{ value?: unknown }>;
    const messages: Array<CursorIdeBubbleMessage & { order: number }> = [];
    for (const row of rows) {
      if (typeof row.value !== "string") continue;
      let bubble: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.value) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        bubble = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const role = bubble.type === 1 ? "user" : bubble.type === 2 ? "assistant" : null;
      if (!role || typeof bubble.text !== "string") continue;
      const text = visibleBubbleText(role, bubble.text);
      if (!text) continue;
      const createdAt = bubble.createdAt;
      const timestamp =
        typeof createdAt === "number"
          ? createdAt
          : typeof createdAt === "string"
            ? Date.parse(createdAt)
            : Number.NaN;
      messages.push({
        role,
        text,
        ...(Number.isFinite(timestamp) ? { timestamp } : {}),
        order: Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER,
      });
    }
    messages.sort((left, right) => left.order - right.order);
    return messages.map(({ role, text, timestamp }) => ({
      role,
      text,
      ...(timestamp !== undefined ? { timestamp } : {}),
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

async function workspacePath(userDir: string, workspaceId: string): Promise<string | undefined> {
  if (!/^[a-z0-9_-]+$/i.test(workspaceId)) return;
  try {
    const workspace = JSON.parse(
      await readFile(join(userDir, "workspaceStorage", workspaceId, "workspace.json"), "utf8"),
    ) as { folder?: unknown };
    if (typeof workspace.folder !== "string") return;
    const path = fileURLToPath(workspace.folder);
    return isAbsolute(path) ? path : undefined;
  } catch {
    return;
  }
}

/** Show the chats currently rendered by Cursor, enriched with their local workspace metadata. */
export async function scanCursorIdeHistory(
  userDir = cursorIdeUserDir(),
  listVisible: () => Promise<CursorIdeVisibleChat[]> = listCursorIdeVisibleChats,
  onUnavailable?: (message: string) => void,
): Promise<NativeHistorySession[]> {
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(join(userDir, "globalStorage", "state.vscdb"), { readOnly: true });
    const visible = await listVisible();
    if (!visible.length) return [];
    const rows = db
      .prepare(
        "SELECT composerId, workspaceId, lastUpdatedAt, value FROM composerHeaders WHERE isSubagent = 0 OR isSubagent IS NULL",
      )
      .all();
    const byId = new Map<string, (typeof rows)[number]>();
    const ambiguous = new Set<string>();
    for (const row of rows) {
      if (typeof row.composerId === "string" && UUID.test(row.composerId)) {
        if (byId.has(row.composerId)) ambiguous.add(row.composerId);
        byId.set(row.composerId, row);
      }
    }
    const workspaceCache = new Map<string, string | undefined>();
    const seen = new Set<string>();
    const result: NativeHistorySession[] = [];
    for (const chat of visible) {
      const possibleIds = byId.has(chat.id)
        ? [chat.id]
        : [...byId.keys()].filter((id) => chat.id.length >= 32 && id.startsWith(chat.id));
      const nativeId = possibleIds.length === 1 ? possibleIds[0] : chat.id;
      if (!UUID.test(nativeId) || seen.has(nativeId)) continue;
      const row = ambiguous.has(nativeId) ? undefined : byId.get(nativeId);
      const workspaceId = typeof row?.workspaceId === "string" ? row.workspaceId : undefined;
      if (workspaceId && !workspaceCache.has(workspaceId)) {
        workspaceCache.set(workspaceId, await workspacePath(userDir, workspaceId));
      }
      const projectDir = workspaceId ? workspaceCache.get(workspaceId) : undefined;
      result.push({
        provider: "cursor",
        id: `${CURSOR_IDE_HISTORY_PREFIX}${nativeId}`,
        projectDir,
        title: chat.title,
        ...(chat.section || !projectDir ? { cursorIdeGroup: chat.section || "工作目录未知" } : {}),
        ...(!projectDir
          ? {
              cursorIdeUnavailable:
                "无法确认此会话的本机工作目录，请在 Cursor 打开对应项目后刷新列表",
            }
          : {}),
        updatedAt: typeof row?.lastUpdatedAt === "number" ? row.lastUpdatedAt : Date.now(),
        kind: "main",
        hasConversation: true,
      });
      seen.add(nativeId);
    }
    return result;
  } catch (error) {
    // Cursor may be absent or may use a different schema; other providers remain usable.
    if (db)
      onUnavailable?.(
        error instanceof CursorIdeError
          ? error.message
          : "读取 Cursor IDE 会话列表失败，请确认 Cursor 窗口已打开后刷新",
      );
    return [];
  } finally {
    db?.close();
  }
}
