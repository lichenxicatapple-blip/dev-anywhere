import { createHash } from "node:crypto";
import { ControlErrorCode } from "@dev-anywhere/shared";

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_SETTLED_TTL_MS = 30 * 60_000;

type PreviewOperationKind =
  | "web:create"
  | "web:rename"
  | "web:reconnect"
  | "web:close"
  | "device:create"
  | "device:rename"
  | "device:reconnect"
  | "device:close";

interface OperationEntry {
  kind: PreviewOperationKind;
  fingerprint: string;
  promise: Promise<unknown>;
  state: "in_flight" | "settled";
  settledAt?: number;
}

interface PreviewOperationJournalOptions {
  maxEntries?: number;
  settledTtlMs?: number;
  now?: () => number;
}

export class PreviewOperationJournalError extends Error {
  constructor(
    message: string,
    readonly errorCode: ControlErrorCode,
  ) {
    super(message);
    this.name = "PreviewOperationJournalError";
  }
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Preview operation parameters must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalize(field)}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("Preview operation parameters must be JSON-compatible");
}

export function fingerprintPreviewOperationParameters(parameters: unknown): string {
  return createHash("sha256").update(canonicalize(parameters)).digest("hex");
}

/**
 * Bounded, process-local exactly-once window for Preview mutations. A settled rejection is kept
 * just like a success: retrying an operation whose ACK was lost must observe the same outcome,
 * never execute the side effect again.
 */
export class PreviewOperationJournal {
  private readonly entries = new Map<string, OperationEntry>();
  private readonly maxEntries: number;
  private readonly settledTtlMs: number;
  private readonly now: () => number;

  constructor(options: PreviewOperationJournalOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.settledTtlMs = Math.max(1, options.settledTtlMs ?? DEFAULT_SETTLED_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  run<T>(
    operationId: string,
    kind: PreviewOperationKind,
    parameters: unknown,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    const fingerprint = fingerprintPreviewOperationParameters(parameters);
    const now = this.now();
    this.pruneExpired(now);

    const existing = this.entries.get(operationId);
    if (existing) {
      if (existing.kind !== kind || existing.fingerprint !== fingerprint) {
        throw new PreviewOperationJournalError(
          "operationId 已用于不同的预览操作",
          ControlErrorCode.OPERATION_CONFLICT,
        );
      }
      return existing.promise as Promise<T>;
    }

    this.ensureCapacity();
    const entry: OperationEntry = {
      kind,
      fingerprint,
      state: "in_flight",
      promise: Promise.resolve()
        .then(execute)
        .then(
          (value) => {
            entry.state = "settled";
            entry.settledAt = this.now();
            return value;
          },
          (error: unknown) => {
            entry.state = "settled";
            entry.settledAt = this.now();
            throw error;
          },
        ),
    };
    this.entries.set(operationId, entry);
    return entry.promise as Promise<T>;
  }

  clear(): void {
    this.entries.clear();
  }

  private ensureCapacity(): void {
    if (this.entries.size < this.maxEntries) return;
    let oldest: [string, OperationEntry] | undefined;
    for (const candidate of this.entries) {
      const [, entry] = candidate;
      if (entry.state !== "settled" || entry.settledAt === undefined) continue;
      if (!oldest || entry.settledAt < oldest[1].settledAt!) oldest = candidate;
    }
    if (oldest) {
      this.entries.delete(oldest[0]);
      return;
    }
    throw new PreviewOperationJournalError("待处理的预览操作过多", ControlErrorCode.RATE_LIMITED);
  }

  private pruneExpired(now: number): void {
    for (const [operationId, entry] of this.entries) {
      if (
        entry.state === "settled" &&
        entry.settledAt !== undefined &&
        entry.settledAt + this.settledTtlMs <= now
      ) {
        this.entries.delete(operationId);
      }
    }
  }
}
