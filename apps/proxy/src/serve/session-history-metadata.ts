import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../common/atomic-write.js";
import type { ProviderId } from "../providers/types.js";

export interface SessionHistoryMetadataRecord {
  nativeSessionId: string;
  devAnywhereSessionId: string;
  provider: ProviderId;
  mode: "pty" | "json";
  cwd: string;
  title?: string;
  updatedAt: number;
}

export interface HistorySessionLike {
  id: string;
  provider: ProviderId;
  title?: string;
  projectDir?: string;
  preferredMode?: "pty" | "json";
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "claude" || value === "codex";
}

function isSessionMode(value: unknown): value is "pty" | "json" {
  return value === "pty" || value === "json";
}

function normalizeMetadataRecord(value: unknown): SessionHistoryMetadataRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SessionHistoryMetadataRecord>;
  if (typeof record.nativeSessionId !== "string" || !record.nativeSessionId) return null;
  if (typeof record.devAnywhereSessionId !== "string" || !record.devAnywhereSessionId) return null;
  if (!isProviderId(record.provider)) return null;
  if (!isSessionMode(record.mode)) return null;
  if (typeof record.cwd !== "string" || !record.cwd) return null;
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Date.now();
  return {
    nativeSessionId: record.nativeSessionId,
    devAnywhereSessionId: record.devAnywhereSessionId,
    provider: record.provider,
    mode: record.mode,
    cwd: record.cwd,
    ...(typeof record.title === "string" && record.title.trim()
      ? { title: record.title.trim() }
      : {}),
    updatedAt,
  };
}

export function readSessionHistoryMetadata(
  metadataPath: string | undefined,
): SessionHistoryMetadataRecord[] {
  if (!metadataPath || !existsSync(metadataPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const record = normalizeMetadataRecord(value);
      return record ? [record] : [];
    });
  } catch {
    return [];
  }
}

export function writeSessionHistoryMetadata(
  metadataPath: string,
  records: SessionHistoryMetadataRecord[],
): void {
  atomicWriteFileSync(metadataPath, `${JSON.stringify(records, null, 2)}\n`, { ensureDir: true });
}

export function upsertSessionHistoryMetadata(
  metadataPath: string | undefined,
  record: SessionHistoryMetadataRecord,
): void {
  if (!metadataPath) return;
  const records = readSessionHistoryMetadata(metadataPath);
  const key = metadataKey(record.provider, record.nativeSessionId);
  const next = [
    record,
    ...records.filter(
      (existing) => metadataKey(existing.provider, existing.nativeSessionId) !== key,
    ),
  ];
  writeSessionHistoryMetadata(metadataPath, next);
}

export function applySessionHistoryMetadata<T extends HistorySessionLike>(
  sessions: T[],
  metadata: SessionHistoryMetadataRecord[],
): T[] {
  if (metadata.length === 0) return sessions;
  const byNativeSession = new Map<string, SessionHistoryMetadataRecord>();
  for (const record of metadata) {
    const key = metadataKey(record.provider, record.nativeSessionId);
    const existing = byNativeSession.get(key);
    if (!existing || existing.updatedAt < record.updatedAt) byNativeSession.set(key, record);
  }
  return sessions.map((session) => {
    const record = byNativeSession.get(metadataKey(session.provider, session.id));
    return record
      ? {
          ...session,
          title: record.title ?? session.title,
          projectDir: record.cwd || session.projectDir,
          preferredMode: record.mode,
        }
      : session;
  });
}

function metadataKey(provider: ProviderId, nativeSessionId: string): string {
  return `${provider}:${nativeSessionId}`;
}
