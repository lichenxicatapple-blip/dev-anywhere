import { createRequire } from "node:module";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { asRecord } from "./files.js";
import { cursorAcpSessionsDir } from "./paths.js";
import { normalizeHistoryTitle } from "./title.js";
import { SAFE_SESSION_ID_PATTERN, type NativeHistorySession } from "./types.js";

const META_FILE = "meta.json";
const STORE_FILE = "store.db";
const ROOT_HASH_SIZE = 32;
const PROTO_VARINT_MAX_BYTES = 5;
const require = createRequire(import.meta.url);

interface CursorAcpMeta {
  cwd?: string;
  title?: string;
}

interface CursorStore {
  prepare(sql: string): {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  close(): void;
}

type DatabaseSyncCtor = new (
  path: string,
  options?: { readOnly?: boolean },
) => CursorStore;

let cachedDatabaseSync: DatabaseSyncCtor | null | undefined;

function loadDatabaseSync(): DatabaseSyncCtor | null {
  if (cachedDatabaseSync !== undefined) return cachedDatabaseSync;
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync?: DatabaseSyncCtor };
    cachedDatabaseSync = typeof sqlite.DatabaseSync === "function" ? sqlite.DatabaseSync : null;
  } catch {
    cachedDatabaseSync = null;
  }
  return cachedDatabaseSync;
}

function readProtoVarint(
  root: Uint8Array,
  offset: number,
): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < root.length && index - offset < PROTO_VARINT_MAX_BYTES) {
    const byte = root[index++];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7;
  }
  return null;
}

export function parseCursorRoot(root: Uint8Array): { blobIds: string[]; inlineJson: unknown[] } {
  const blobIds: string[] = [];
  const inlineJson: unknown[] = [];
  let offset = 0;
  while (offset < root.length) {
    const tag = readProtoVarint(root, offset);
    if (!tag) break;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    offset = tag.next;
    if (wire === 0) {
      const value = readProtoVarint(root, offset);
      if (!value) break;
      offset = value.next;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      continue;
    }
    if (wire !== 2) break;
    const length = readProtoVarint(root, offset);
    if (!length) break;
    offset = length.next;
    if (offset + length.value > root.length) break;
    const data = root.subarray(offset, offset + length.value);
    offset += length.value;
    if (field === 1 && length.value === ROOT_HASH_SIZE) {
      blobIds.push(Buffer.from(data).toString("hex"));
      continue;
    }
    if (field === 4 && data[0] === 0x7b) {
      try {
        inlineJson.push(JSON.parse(Buffer.from(data).toString("utf8")));
      } catch {
        // A malformed in-progress assistant blob must not hide hashed turns.
      }
    }
  }
  return { blobIds, inlineJson };
}

export function parseCursorRootBlobIds(root: Uint8Array): string[] {
  return parseCursorRoot(root).blobIds;
}

function readCursorMetaFile(raw: string): CursorAcpMeta | null {
  const meta = asRecord(JSON.parse(raw));
  if (!meta) return null;
  return {
    ...(typeof meta.cwd === "string" ? { cwd: meta.cwd } : {}),
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
  };
}

function decodeStoreMeta(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const decoded = /^[0-9a-fA-F]+$/.test(value)
      ? Buffer.from(value, "hex").toString("utf8")
      : value;
    return asRecord(JSON.parse(decoded));
  } catch {
    return null;
  }
}

function openCursorStore(storePath: string): CursorStore | null {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) return null;
  try {
    return new DatabaseSync(storePath, { readOnly: true });
  } catch {
    try {
      // WAL databases may need a writable shm file even for SELECT.
      return new DatabaseSync(storePath);
    } catch {
      return null;
    }
  }
}

function readStoreBlob(db: CursorStore, id: string): Uint8Array | null {
  const row = db.prepare("SELECT data FROM blobs WHERE id = ?").get(id) as
    | { data?: unknown }
    | undefined;
  if (!row) return null;
  if (row.data instanceof Uint8Array) return row.data;
  if (Buffer.isBuffer(row.data)) return row.data;
  return null;
}

function readLatestRootBlobId(db: CursorStore): string | null {
  const keyed = db.prepare("SELECT value FROM meta WHERE key = ?").get("0") as
    | { value?: unknown }
    | undefined;
  const fromKeyed = decodeStoreMeta(keyed?.value)?.latestRootBlobId;
  if (typeof fromKeyed === "string") return fromKeyed;
  const rows = db.prepare("SELECT value FROM meta").all() as Array<{ value?: unknown }>;
  for (const row of rows) {
    const rootId = decodeStoreMeta(row.value)?.latestRootBlobId;
    if (typeof rootId === "string") return rootId;
  }
  return null;
}

function conversationRecordIdentity(record: unknown): string | null {
  const parsed = asRecord(record);
  return parsed && typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null;
}

function cursorUserTextHasConversation(text: string): boolean {
  if (/<user_query>\s*\S[\s\S]*?<\/user_query>/i.test(text)) return true;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !/^<(?:user_info|timestamp|environment_context|conversation_summary)(?:[\s>:-])/i.test(
    trimmed,
  );
}

export function cursorRecordHasConversation(record: unknown): boolean {
  const parsed = asRecord(record);
  if (!parsed || typeof parsed.role !== "string") return false;
  if (parsed.role === "assistant" || parsed.role === "tool") return true;
  if (parsed.role !== "user") return false;
  if (typeof parsed.content === "string") return cursorUserTextHasConversation(parsed.content);
  if (!Array.isArray(parsed.content)) return false;
  return parsed.content.some((block) => {
    const part = asRecord(block);
    return (
      part?.type === "text" &&
      typeof part.text === "string" &&
      cursorUserTextHasConversation(part.text)
    );
  });
}

function appendConversationRecord(records: unknown[], seenIds: Set<string>, record: unknown): void {
  const identity = conversationRecordIdentity(record);
  if (identity) {
    if (seenIds.has(identity)) return;
    seenIds.add(identity);
  }
  records.push(record);
}

export function readCursorConversationRecordsFromStore(storePath: string): unknown[] {
  const db = openCursorStore(storePath);
  if (!db) return [];
  try {
    const rootId = readLatestRootBlobId(db);
    if (!rootId) return [];
    const root = readStoreBlob(db, rootId);
    if (!root) return [];
    const { blobIds, inlineJson } = parseCursorRoot(root);
    const records: unknown[] = [];
    const seenIds = new Set<string>();
    for (const blobId of blobIds) {
      const blob = readStoreBlob(db, blobId);
      if (!blob || blob[0] !== 0x7b) continue;
      try {
        appendConversationRecord(records, seenIds, JSON.parse(Buffer.from(blob).toString("utf8")));
      } catch {
        // A single corrupt conversation blob must not hide the rest of the turn list.
      }
    }
    for (const record of inlineJson) appendConversationRecord(records, seenIds, record);
    return records;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // Closing a corrupt handle must not surface as a history read failure.
    }
  }
}

export async function readCursorConversationRecords(sessionId: string): Promise<unknown[]> {
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) return [];
  const storePath = join(cursorAcpSessionsDir(), sessionId, STORE_FILE);
  try {
    const info = await lstat(storePath);
    if (!info.isFile() || info.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  return readCursorConversationRecordsFromStore(storePath);
}

async function latestExistingFileTime(paths: string[], fallback: number): Promise<number> {
  let latest = fallback;
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs > latest) latest = info.mtimeMs;
    } catch {
      // WAL/SHM sidecars are optional.
    }
  }
  return latest;
}

/** ACP chat transcripts live at ~/.cursor/acp-sessions/<id>/{meta.json,store.db}. */
export async function scanCursorHistory(root: string): Promise<NativeHistorySession[]> {
  const result: NativeHistorySession[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_SESSION_ID_PATTERN.test(entry.name)) continue;
    const directory = join(root, entry.name);
    try {
      const metaPath = join(directory, META_FILE);
      const metaInfo = await lstat(metaPath);
      if (!metaInfo.isFile() || metaInfo.isSymbolicLink()) continue;
      const meta = readCursorMetaFile(await readFile(metaPath, "utf8"));
      if (!meta || typeof meta.cwd !== "string" || !isAbsolute(meta.cwd)) continue;
      const storePath = join(directory, STORE_FILE);
      let hasStore = false;
      try {
        const storeInfo = await lstat(storePath);
        hasStore = storeInfo.isFile() && !storeInfo.isSymbolicLink();
      } catch {
        hasStore = false;
      }
      if (!hasStore) continue;
      // Capture mtimes before opening store.db; a reader may touch WAL/SHM sidecars.
      const updatedAt = await latestExistingFileTime(
        [storePath, `${storePath}-wal`, `${storePath}-shm`, metaPath],
        metaInfo.mtimeMs,
      );
      const records = readCursorConversationRecordsFromStore(storePath);
      if (!records.some(cursorRecordHasConversation)) continue;
      const title =
        typeof meta.title === "string" && normalizeHistoryTitle(meta.title) !== null
          ? meta.title
          : undefined;
      result.push({
        provider: "cursor",
        id: entry.name,
        projectDir: meta.cwd,
        updatedAt,
        kind: "main",
        hasConversation: true,
        ...(title !== undefined ? { title } : {}),
      });
    } catch {
      // One malformed ACP session must not hide the remaining native sessions.
    }
  }
  return result;
}
