import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { scanClaudeHistory } from "./claude.js";
import { scanCodexHistory } from "./codex.js";
import { scanKimiHistory } from "./kimi.js";
import { claudeProjectsDir, codexSessionsDir, kimiSessionsDir } from "./paths.js";
import { normalizeHistoryTitle } from "./title.js";
import {
  nativeSessionKey,
  SAFE_SESSION_ID_PATTERN,
  type NativeHistorySession,
  type SessionHistoryEntry,
} from "./types.js";
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

function projectPath(path: string | undefined): string | undefined {
  if (!path || !isAbsolute(path) || path.includes("\0")) return;
  const normalized = resolve(path);
  if (
    temporaryRoots.some((root) => normalized === root || normalized.startsWith(`${root}${sep}`))
  ) {
    return;
  }
  return normalized;
}

/** Identity and visibility are decided from native facts, never from display names. */
export function buildHistoryCatalog(records: NativeHistorySession[]): SessionHistoryEntry[] {
  const byIdentity = new Map<string, SessionHistoryEntry>();
  for (const record of records) {
    if (record.kind === "internal" || !record.hasConversation) continue;
    if (!SAFE_SESSION_ID_PATTERN.test(record.id) || !Number.isFinite(record.updatedAt)) continue;
    const projectDir = projectPath(record.projectDir);
    if (!projectDir) continue;
    const entry: SessionHistoryEntry = {
      id: record.id,
      provider: record.provider,
      projectDir,
      title: normalizeHistoryTitle(record.title) ?? "未命名会话",
      updatedAt: record.updatedAt,
    };
    const key = nativeSessionKey(record);
    const existing = byIdentity.get(key);
    if (!existing || entry.updatedAt > existing.updatedAt) byIdentity.set(key, entry);
  }
  return [...byIdentity.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || nativeSessionKey(a).localeCompare(nativeSessionKey(b)),
  );
}

export async function scanSessionHistory(
  options: { metadataPath?: string } = {},
): Promise<SessionHistoryEntry[]> {
  const records = await Promise.all([
    scanClaudeHistory(claudeProjectsDir()),
    scanCodexHistory(codexSessionsDir()),
    scanKimiHistory(kimiSessionsDir()),
  ]);
  return applySessionHistoryMetadata(
    buildHistoryCatalog(records.flat()),
    readSessionHistoryMetadata(options.metadataPath),
  );
}
