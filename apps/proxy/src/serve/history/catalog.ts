import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { scanClaudeHistory } from "./claude.js";
import { scanCodexHistory } from "./codex.js";
import { CursorHistoryUnavailableError, scanCursorHistory } from "./cursor.js";
import { scanCursorIdeHistory } from "./cursor-ide.js";
import { scanKimiHistory } from "./kimi.js";
import {
  claudeProjectsDir,
  codexSessionsDir,
  cursorAcpSessionsDir,
  kimiSessionsDir,
} from "./paths.js";
import { normalizeHistoryTitle } from "./title.js";
import {
  nativeSessionKey,
  SAFE_SESSION_ID_PATTERN,
  type NativeHistorySession,
  type SessionHistoryEntry,
} from "./types.js";
import { serviceLogger } from "../../common/logger.js";
import {
  applySessionHistoryMetadata,
  readSessionHistoryMetadata,
} from "../session-history-metadata.js";

const temporaryRoots = [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/tmp"])].flatMap(
  (root) => {
    const path = resolve(root);
    if (path.startsWith("/var/")) return [path, `/private${path}`];
    if (path.startsWith("/private/var/")) return [path, path.slice("/private".length)];
    return [path];
  },
);

function projectPath(path: string | undefined, allowTemporary = false): string | undefined {
  if (!path || !isAbsolute(path) || path.includes("\0")) return;
  const normalized = resolve(path);
  if (
    !allowTemporary &&
    temporaryRoots.some((root) => normalized === root || normalized.startsWith(`${root}${sep}`))
  ) {
    return;
  }
  return normalized;
}

/** Identity and visibility are decided from native facts, never from display names. */
export function buildHistoryCatalog(records: NativeHistorySession[]): SessionHistoryEntry[] {
  const byIdentity = new Map<string, SessionHistoryEntry>();
  const cursorIdeOrder = new Map<string, number>();
  for (const record of records) {
    if (record.kind === "internal" || !record.hasConversation) continue;
    if (!SAFE_SESSION_ID_PATTERN.test(record.id) || !Number.isFinite(record.updatedAt)) continue;
    const isCursorIde = record.provider === "cursor" && record.id.startsWith("cursor_ide_");
    const isUnavailableCursorIde = isCursorIde && !!record.cursorIdeUnavailable;
    const projectDir =
      projectPath(record.projectDir, isCursorIde) ?? (isUnavailableCursorIde ? "" : undefined);
    if (projectDir === undefined) continue;
    const entry: SessionHistoryEntry = {
      id: record.id,
      provider: record.provider,
      projectDir,
      title: isCursorIde
        ? record.title?.replace(/\s+/g, " ").trim().slice(0, 512) || "未命名会话"
        : (normalizeHistoryTitle(record.title) ?? "未命名会话"),
      updatedAt: record.updatedAt,
      ...(record.cursorIdeGroup ? { cursorIdeGroup: record.cursorIdeGroup } : {}),
      ...(record.cursorIdeUnavailable ? { cursorIdeUnavailable: record.cursorIdeUnavailable } : {}),
    };
    const key = nativeSessionKey(record);
    if (isCursorIde && !cursorIdeOrder.has(key)) {
      cursorIdeOrder.set(key, cursorIdeOrder.size);
    }
    const existing = byIdentity.get(key);
    if (!existing || entry.updatedAt > existing.updatedAt) byIdentity.set(key, entry);
  }
  const sorted = [...byIdentity.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || nativeSessionKey(a).localeCompare(nativeSessionKey(b)),
  );
  // Keep Cursor's sidebar order without changing where other providers appear in the catalog.
  const cursorIdeEntries = sorted
    .filter((entry) => cursorIdeOrder.has(nativeSessionKey(entry)))
    .sort(
      (a, b) => cursorIdeOrder.get(nativeSessionKey(a))! - cursorIdeOrder.get(nativeSessionKey(b))!,
    );
  let nextCursorIde = 0;
  return sorted.map((entry) =>
    cursorIdeOrder.has(nativeSessionKey(entry)) ? cursorIdeEntries[nextCursorIde++] : entry,
  );
}

export async function scanSessionHistory(
  options: { metadataPath?: string; onCursorIdeUnavailable?: (message: string) => void } = {},
): Promise<SessionHistoryEntry[]> {
  const records = await Promise.all([
    scanClaudeHistory(claudeProjectsDir()),
    scanCodexHistory(codexSessionsDir()),
    scanKimiHistory(kimiSessionsDir()),
    scanCursorIdeHistory(undefined, undefined, options.onCursorIdeUnavailable),
    scanCursorHistory(cursorAcpSessionsDir()).catch((error: unknown) => {
      // 不支持 Cursor 历史的环境只影响 Cursor，不能拖垮其他 Agent 的历史列表。
      if (!(error instanceof CursorHistoryUnavailableError)) throw error;
      serviceLogger.warn({ error: error.message }, "Cursor history is unavailable");
      return [];
    }),
  ]);
  return applySessionHistoryMetadata(
    buildHistoryCatalog(records.flat()),
    readSessionHistoryMetadata(options.metadataPath),
  );
}
