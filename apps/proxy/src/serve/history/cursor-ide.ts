import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectJsonlFiles } from "./files.js";
import type { NativeHistorySession } from "./types.js";
import {
  cursorIdeNativeId,
  cursorIdeUserDir,
  CURSOR_IDE_HISTORY_PREFIX,
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
