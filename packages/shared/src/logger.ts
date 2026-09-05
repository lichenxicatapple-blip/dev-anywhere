import {
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import pino from "pino";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  logDir?: string;
  retention?: number;
  // A live process must never be able to grow one log file without bound. The limit is applied
  // to serialized UTF-8 bytes and rotation keeps at most maxFilesPerRun files for this process.
  maxFileBytes?: number;
  maxFilesPerRun?: number;
  maxRecordBytes?: number;
  retentionBytes?: number;
  stdout?: boolean;
  silent?: boolean;
  // 同步落盘：sonic-boom 默认异步 open + 异步 write，测试里需要在断言前看到文件，
  // 或在 afterEach 删目录前确保后台 worker 已经退出，必须开同步。生产保留异步以避免热路径阻塞。
  sync?: boolean;
}

const DEFAULT_LOG_DIR = `${homedir()}/.dev-anywhere/logs`;
const DEFAULT_LOG_RETENTION = 50;
const DEFAULT_LOG_RETENTION_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_RUN = 2;
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
const DEFAULT_MAX_STDOUT_BUFFER_BYTES = 1024 * 1024;
const LOG_IO_OPERATION_TIMEOUT_MS = 5_000;
const LOG_RUN_LEASE_SUFFIX = ".active";
const LOG_RUN_LEASE_CANDIDATE_MARKER = `${LOG_RUN_LEASE_SUFFIX}.candidate-`;

const PROCESS_LOG_RUN_ID = sanitizeRunId(
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function linkLatestLog(logDir: string, name: string, filePath: string, runId: string): void {
  const latestPath = join(logDir, `${name}.log`);

  try {
    const stat = lstatSync(latestPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(latestPath);
    } else {
      renameSync(latestPath, join(logDir, `${name}-legacy-${runId}.log`));
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return;
  }

  try {
    symlinkSync(basename(filePath), latestPath);
  } catch {
    // 日志本体仍然写入 run-specific 文件；latest 链接失败不应阻塞服务启动。
  }
}

function resolveRetention(retention: number | undefined): number {
  if (retention === undefined) return DEFAULT_LOG_RETENTION;
  return Number.isFinite(retention) && retention >= 0
    ? Math.floor(retention)
    : DEFAULT_LOG_RETENTION;
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

interface LogRunLease {
  version: 1;
  pid: number;
  runId: string;
  fileName: string;
}

function leasePathForLog(filePath: string): string {
  return `${filePath}${LOG_RUN_LEASE_SUFFIX}`;
}

function createLogRunLease(filePath: string, runId: string): void {
  const lease: LogRunLease = {
    version: 1,
    pid: process.pid,
    runId,
    fileName: basename(filePath),
  };
  const leasePath = leasePathForLog(filePath);
  const candidatePath = `${leasePath}.candidate-${process.pid}-${randomUUID()}`;
  let candidateCreated = false;
  try {
    // Publish through a hard link only after the same-directory candidate has been completely
    // written and closed. Unlike writing directly to the final path, readers can therefore never
    // observe an empty or partially serialized lease, and link(2) retains O_EXCL semantics.
    writeFileSync(candidatePath, `${JSON.stringify(lease)}\n`, { flag: "wx" });
    candidateCreated = true;
    linkSync(candidatePath, leasePath);
  } finally {
    if (candidateCreated) {
      try {
        unlinkSync(candidatePath);
      } catch {
        // A crash or unlink failure can leave a valid candidate. A future logger run reclaims it
        // once its owner is known to be dead.
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type LogRunLeaseReadResult =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "valid"; lease: LogRunLease };

function readLogRunLease(leasePath: string, expectedFileName: string): LogRunLeaseReadResult {
  let raw: string;
  try {
    raw = readFileSync(leasePath, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "invalid" };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LogRunLease>;
    const pid = parsed.pid;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(pid) ||
      typeof pid !== "number" ||
      pid <= 0 ||
      typeof parsed.runId !== "string" ||
      parsed.runId.length === 0 ||
      parsed.fileName !== expectedFileName
    ) {
      throw new Error("Invalid log run lease");
    }
    return { state: "valid", lease: parsed as LogRunLease };
  } catch {
    // A malformed lease might be a concurrently published or externally damaged ownership
    // record. Fail closed: neither the lease nor its corresponding log may be deleted.
    return { state: "invalid" };
  }
}

function hasLiveLogRunLease(filePath: string): boolean {
  const leasePath = leasePathForLog(filePath);
  const result = readLogRunLease(leasePath, basename(filePath));
  if (result.state === "missing") return false;
  if (result.state === "invalid") return true;

  if (isProcessAlive(result.lease.pid)) return true;
  try {
    unlinkSync(leasePath);
  } catch {
    // The owning process is gone, so the log is stale even if its lease cannot be removed.
  }
  return false;
}

function removeOwnedLogRunLease(filePath: string, runId: string): void {
  const leasePath = leasePathForLog(filePath);
  const result = readLogRunLease(leasePath, basename(filePath));
  if (
    result.state !== "valid" ||
    result.lease.pid !== process.pid ||
    result.lease.runId !== runId
  ) {
    return;
  }
  try {
    unlinkSync(leasePath);
  } catch {
    // Cleanup is best effort. A valid lease left behind is reclaimable after this process exits.
  }
}

function parseLeaseEntry(
  entry: string,
  name: string,
): { fileName: string; candidate: boolean } | null {
  const prefix = `${name}-`;
  if (!entry.startsWith(prefix)) return null;
  if (entry.endsWith(LOG_RUN_LEASE_SUFFIX)) {
    const fileName = entry.slice(0, -LOG_RUN_LEASE_SUFFIX.length);
    return fileName.endsWith(".log") ? { fileName, candidate: false } : null;
  }

  const markerIndex = entry.lastIndexOf(LOG_RUN_LEASE_CANDIDATE_MARKER);
  if (markerIndex < 0 || markerIndex + LOG_RUN_LEASE_CANDIDATE_MARKER.length >= entry.length) {
    return null;
  }
  const fileName = entry.slice(0, markerIndex);
  return fileName.endsWith(".log") ? { fileName, candidate: true } : null;
}

function pruneOrphanedLogRunLeases(logDir: string, name: string): void {
  for (const entry of readdirSync(logDir)) {
    const parsedEntry = parseLeaseEntry(entry, name);
    if (!parsedEntry) continue;

    const leasePath = join(logDir, entry);
    const result = readLogRunLease(leasePath, parsedEntry.fileName);
    if (result.state !== "valid" || isProcessAlive(result.lease.pid)) continue;

    let correspondingLogExists = false;
    try {
      statSync(join(logDir, parsedEntry.fileName));
      correspondingLogExists = true;
    } catch {
      // A missing log makes a valid dead-owner lease an orphan.
    }
    if (!parsedEntry.candidate && correspondingLogExists) continue;

    try {
      unlinkSync(leasePath);
    } catch {
      // A concurrent cleanup or filesystem error must not prevent logger startup.
    }
  }
}

function removeLogAndLease(filePath: string): void {
  unlinkSync(filePath);
  try {
    unlinkSync(leasePathForLog(filePath));
  } catch {
    // Missing or concurrently removed stale leases need no further cleanup.
  }
}

function pruneOldLogs(
  logDir: string,
  name: string,
  currentFilePath: string,
  retention: number | undefined,
  retentionBytes: number | undefined,
): void {
  const keep = resolveRetention(retention);
  const byteBudget = resolvePositiveInteger(retentionBytes, DEFAULT_LOG_RETENTION_BYTES);
  pruneOrphanedLogRunLeases(logDir, name);
  if (keep === 0) return;

  const currentFileName = basename(currentFilePath);
  const prefix = `${name}-`;
  const candidates = readdirSync(logDir)
    .filter(
      (entry) => entry.startsWith(prefix) && entry.endsWith(".log") && entry !== currentFileName,
    )
    .map((entry) => {
      const path = join(logDir, entry);
      try {
        const stat = statSync(path);
        return { path, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number; size: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const retained: typeof candidates = [];
  let retainedBytes = 0;
  for (const candidate of candidates) {
    if (hasLiveLogRunLease(candidate.path)) {
      retained.push(candidate);
      retainedBytes += candidate.size;
      continue;
    }
    const withinCount = keep === 0 || retained.length < Math.max(0, keep - 1);
    const withinBytes = retainedBytes + candidate.size <= byteBudget;
    if (withinCount && withinBytes) {
      retained.push(candidate);
      retainedBytes += candidate.size;
      continue;
    }
    try {
      removeLogAndLease(candidate.path);
    } catch {
      // 日志清理失败不能影响主进程启动。
    }
  }
}

// SonicBoom 实例的最小结构契约（pino.destination 返回它，但 pino 类型只暴露 DestinationStream
// 接口，没有 fd / flushSync / once，所以这里手写一个结构类型用于 flushLogger）。
interface SonicLikeDestination {
  fd?: number;
  _writing?: boolean;
  sync?: boolean;
  write?: (data: string) => boolean | void;
  reopen?: (filePath?: string) => void;
  flushSync?: () => void;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  off?: (event: string, cb: (...args: unknown[]) => void) => void;
  once?: (event: string, cb: (...args: unknown[]) => void) => void;
  listenerCount?: (event: string) => number;
}

function waitForDestinationEvent(
  destination: SonicLikeDestination,
  event: string,
  deadline?: number,
): Promise<boolean> {
  if (!destination.on || !destination.off) return Promise.resolve(false);
  const addListener = destination.on.bind(destination);
  const removeListener = destination.off.bind(destination);
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      removeListener(event, onEvent);
      removeListener("error", onError);
    };
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onEvent = () => settle(true);
    const onError = () => settle(false);

    addListener(event, onEvent);
    addListener("error", onError);
    if (remaining !== undefined) {
      timer = setTimeout(() => settle(false), remaining);
      timer.unref?.();
    }
  });
}

interface WritableLikeDestination {
  writableLength?: number;
  write(data: string): boolean | void;
}

class BoundedWritableDestination implements pino.DestinationStream {
  private droppedRecords = 0;
  private saturated = false;

  constructor(
    private readonly destination: WritableLikeDestination,
    private readonly maxPendingBytes: number,
  ) {}

  write(serialized: string): void {
    if (this.saturated) return;
    const bytes = Buffer.byteLength(serialized);
    const pendingBytes = this.destination.writableLength;
    if (
      bytes > this.maxPendingBytes ||
      typeof pendingBytes !== "number" ||
      !Number.isFinite(pendingBytes)
    ) {
      this.droppedRecords += 1;
      return;
    }

    const droppedDiagnostic =
      this.droppedRecords > 0
        ? `${JSON.stringify({
            level: 40,
            time: Date.now(),
            msg: "Log records were dropped while stdout was backpressured",
            dropped: this.droppedRecords,
          })}\n`
        : null;
    const diagnosticBytes = droppedDiagnostic ? Buffer.byteLength(droppedDiagnostic) : 0;
    if (pendingBytes + diagnosticBytes + bytes > this.maxPendingBytes) {
      this.droppedRecords += 1;
      return;
    }

    try {
      if (droppedDiagnostic) this.destination.write(droppedDiagnostic);
      this.destination.write(serialized);
      this.droppedRecords = 0;
    } catch {
      this.saturated = true;
    }
  }
}

class BoundedLogDestination implements pino.DestinationStream, SonicLikeDestination {
  private currentBytes = 0;
  private rotating = false;
  private saturated = false;
  private droppedDuringRotation = 0;
  private pendingRecord: string | null = null;
  private rotationPromise: Promise<void> | null = null;
  private readonly rotationWaiters = new Set<() => void>();

  constructor(
    private readonly destination: SonicLikeDestination,
    private readonly filePath: string,
    private readonly runId: string,
    private readonly logDir: string,
    private readonly name: string,
    private readonly retention: number | undefined,
    private readonly retentionBytes: number | undefined,
    private readonly maxFileBytes: number,
    private readonly maxFilesPerRun: number,
    private readonly maxRecordBytes: number,
    initialBytes: number,
  ) {
    this.currentBytes = initialBytes;
    // A filesystem failure in SonicBoom must not turn diagnostics into an uncaught process
    // exception. Stop accepting further records; the application can keep serving and the
    // already-enforced byte bound still holds.
    this.destination.on?.("error", () => {
      this.rotating = false;
      this.saturated = true;
      if (this.destination.fd == null || this.destination.fd < 0) {
        removeOwnedLogRunLease(this.filePath, this.runId);
      }
    });
  }

  get fd(): number | undefined {
    return this.destination.fd;
  }

  get _writing(): boolean | undefined {
    return this.destination._writing;
  }

  once(event: string, cb: (...args: unknown[]) => void): void {
    this.destination.once?.(event, cb);
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    this.destination.on?.(event, cb);
  }

  off(event: string, cb: (...args: unknown[]) => void): void {
    this.destination.off?.(event, cb);
  }

  listenerCount(event: string): number {
    return this.destination.listenerCount?.(event) ?? 0;
  }

  write(serialized: string): void {
    if (this.saturated) return;
    const record = this.boundRecord(serialized);
    if (!record) return;
    const bytes = Buffer.byteLength(record);

    if (this.rotating) {
      this.droppedDuringRotation += 1;
      return;
    }
    if (this.currentBytes + bytes > this.maxFileBytes) {
      this.startRotation(record);
      return;
    }

    this.writeActiveRecord(record);
  }

  flushSync(): void {
    this.destination.flushSync?.();
  }

  async waitForRotation(deadline: number): Promise<boolean> {
    while (this.rotationPromise) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const settled = await new Promise<boolean>((resolve) => {
        let finished = false;
        const waiter = () => finish(true);
        const timer = setTimeout(() => finish(false), remaining);
        timer.unref?.();
        const finish = (result: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.rotationWaiters.delete(waiter);
          resolve(result);
        };

        this.rotationWaiters.add(waiter);
        if (!this.rotationPromise) finish(true);
      });
      if (!settled) return false;
    }
    return true;
  }

  private boundRecord(serialized: string): string | null {
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= this.maxRecordBytes && bytes <= this.maxFileBytes) return serialized;
    return this.boundDiagnostic({
      level: 40,
      time: Date.now(),
      msg: "Log entry omitted because it exceeded the configured byte limit",
      originalBytes: bytes,
    });
  }

  private boundDiagnostic(value: Record<string, unknown>): string | null {
    const serialized = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(serialized);
    return bytes <= this.maxRecordBytes && bytes <= this.maxFileBytes ? serialized : null;
  }

  private segmentPath(index: number): string {
    return this.filePath.replace(/\.log$/, `.${index}.log`);
  }

  private writeActiveRecord(record: string): boolean {
    const bytes = Buffer.byteLength(record);
    if (!this.destination.write || this.currentBytes + bytes > this.maxFileBytes) return false;
    this.currentBytes += bytes;
    try {
      this.destination.write(record);
      return !this.saturated;
    } catch {
      this.saturated = true;
      return false;
    }
  }

  private startRotation(pendingRecord: string): void {
    if (this.rotating || this.saturated) return;
    this.rotating = true;
    this.pendingRecord = pendingRecord;

    const tracked = Promise.resolve()
      .then(() => this.performRotation())
      .catch(() => {
        this.saturated = true;
        this.rotating = false;
        this.pendingRecord = null;
        this.droppedDuringRotation = 0;
      })
      .finally(() => {
        if (this.rotationPromise === tracked) this.rotationPromise = null;
        for (const waiter of this.rotationWaiters) waiter();
        this.rotationWaiters.clear();
      });
    this.rotationPromise = tracked;
  }

  private async performRotation(): Promise<void> {
    if (!this.destination.reopen) throw new Error("Log destination cannot be reopened");
    const deadline = Date.now() + LOG_IO_OPERATION_TIMEOUT_MS;

    if (this.destination.fd == null || this.destination.fd < 0) {
      if (!(await waitForDestinationEvent(this.destination, "ready", deadline))) {
        throw new Error("Log destination did not become ready");
      }
    }
    if (this.destination._writing) {
      if (!(await waitForDestinationEvent(this.destination, "drain", deadline))) {
        throw new Error("Log destination did not drain");
      }
    }

    this.rotateFiles();
    this.destination.reopen(this.filePath);
    if (!(await waitForDestinationEvent(this.destination, "ready", deadline))) {
      throw new Error("Rotated log destination did not become ready");
    }
    pruneOldLogs(this.logDir, this.name, this.filePath, this.retention, this.retentionBytes);

    this.currentBytes = 0;
    const pendingRecord = this.pendingRecord;
    this.pendingRecord = null;
    const dropped = this.droppedDuringRotation;
    this.droppedDuringRotation = 0;
    this.rotating = false;

    if (pendingRecord && !this.writeActiveRecord(pendingRecord)) return;
    if (dropped === 0 || this.saturated) return;
    const diagnostic = this.boundDiagnostic({
      level: 40,
      time: Date.now(),
      msg: "Log records were dropped while rotating the active file",
      dropped,
    });
    if (diagnostic && this.currentBytes + Buffer.byteLength(diagnostic) <= this.maxFileBytes) {
      this.writeActiveRecord(diagnostic);
    }
  }

  private rotateFiles(): void {
    if (this.maxFilesPerRun > 1) {
      try {
        unlinkSync(this.segmentPath(this.maxFilesPerRun - 1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (let index = this.maxFilesPerRun - 2; index >= 1; index -= 1) {
        try {
          renameSync(this.segmentPath(index), this.segmentPath(index + 1));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      renameSync(this.filePath, this.segmentPath(1));
    } else {
      unlinkSync(this.filePath);
    }
  }
}

interface FlushOperation {
  promise: Promise<void>;
  settled: boolean;
  waiters: Set<() => void>;
}

interface LoggerMeta {
  materialized: boolean;
  destination: BoundedLogDestination | null;
  flushOperation: FlushOperation | null;
}

const loggerMetaMap = new WeakMap<pino.Logger, LoggerMeta>();

async function flushDestination(
  destination: BoundedLogDestination,
  deadline: number,
): Promise<void> {
  while (true) {
    if (!(await destination.waitForRotation(deadline))) return;

    if (destination.fd == null || destination.fd < 0) {
      if (!(await waitForDestinationEvent(destination, "ready", deadline))) return;
      continue;
    }
    if (destination._writing) {
      if (!(await waitForDestinationEvent(destination, "drain", deadline))) return;
      continue;
    }

    try {
      destination.flushSync();
    } catch {
      // 文件描述符已关闭、磁盘满等极端情况下吞掉异常，避免把退出路径变成崩溃路径。
    }
    return;
  }
}

function resolveFlushTimeout(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : 200;
}

function startFlushOperation(meta: LoggerMeta, destination: BoundedLogDestination): FlushOperation {
  const operation: FlushOperation = {
    promise: flushDestination(destination, Date.now() + LOG_IO_OPERATION_TIMEOUT_MS),
    settled: false,
    waiters: new Set(),
  };
  meta.flushOperation = operation;

  const finish = () => {
    if (operation.settled) return;
    operation.settled = true;
    if (meta.flushOperation === operation) meta.flushOperation = null;
    for (const waiter of operation.waiters) waiter();
    operation.waiters.clear();
  };
  void operation.promise.then(finish, finish);
  return operation;
}

function waitForFlushOperation(operation: FlushOperation, timeoutMs: number): Promise<void> {
  if (operation.settled || timeoutMs <= 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation.waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);

    operation.waiters.add(finish);
    if (operation.settled) {
      finish();
      return;
    }
  });
}

function buildPinoLogger(options: CreateLoggerOptions): {
  logger: pino.Logger;
  destination: BoundedLogDestination | null;
} {
  const {
    name,
    level = "info",
    logDir = DEFAULT_LOG_DIR,
    retention,
    retentionBytes,
    maxFileBytes: requestedMaxFileBytes,
    maxFilesPerRun: requestedMaxFilesPerRun,
    maxRecordBytes: requestedMaxRecordBytes,
    stdout = false,
    silent = false,
    sync = false,
  } = options;

  if (silent) {
    return { logger: pino({ level: "silent" }), destination: null };
  }

  mkdirSync(logDir, { recursive: true });

  const runId = `${PROCESS_LOG_RUN_ID}-${randomUUID()}`;
  const filePath = join(logDir, `${name}-${runId}.log`);
  createLogRunLease(filePath, runId);
  try {
    linkLatestLog(logDir, name, filePath, runId);
    pruneOldLogs(logDir, name, filePath, retention, retentionBytes);
    const maxFileBytes = resolvePositiveInteger(requestedMaxFileBytes, DEFAULT_MAX_FILE_BYTES);
    const maxFilesPerRun = resolvePositiveInteger(
      requestedMaxFilesPerRun,
      DEFAULT_MAX_FILES_PER_RUN,
    );
    const maxRecordBytes = Math.min(
      maxFileBytes,
      resolvePositiveInteger(requestedMaxRecordBytes, DEFAULT_MAX_RECORD_BYTES),
    );
    const sonicDestination = pino.destination({
      dest: filePath,
      sync,
      // Bound data queued while the filesystem is stalled. Dropping diagnostics is preferable to
      // allowing a logging failure to consume the application's heap.
      maxLength: Math.min(maxFileBytes, 1024 * 1024),
    }) as unknown as SonicLikeDestination;
    let initialBytes = 0;
    try {
      initialBytes = statSync(filePath).size;
    } catch {
      // A new run normally reaches this branch because SonicBoom creates the file asynchronously.
    }
    const destination = new BoundedLogDestination(
      sonicDestination,
      filePath,
      runId,
      logDir,
      name,
      retention,
      retentionBytes,
      maxFileBytes,
      maxFilesPerRun,
      maxRecordBytes,
      initialBytes,
    );
    const streams: pino.StreamEntry[] = [{ stream: destination }];

    if (stdout) {
      streams.unshift({
        stream: new BoundedWritableDestination(process.stdout, DEFAULT_MAX_STDOUT_BUFFER_BYTES),
      });
    }

    return { logger: pino({ level }, pino.multistream(streams)), destination };
  } catch (error) {
    removeOwnedLogRunLease(filePath, runId);
    throw error;
  }
}

// 返回一个 lazy proxy：调用 createLogger 本身不触发 mkdirSync / pino.destination
// 等任何文件 IO，只有第一次实际访问 logger 的方法/属性时才构造底层 pino Logger。
// 这样 `dev-anywhere -v` / `dev-anywhere init` 等不需要写日志的命令路径不会
// 落地空 log 文件，也避免异步 SonicBoom 在 process.exit 时未 ready 的 race。
export function createLogger(options: CreateLoggerOptions): pino.Logger {
  let real: pino.Logger | null = null;
  const meta: LoggerMeta = { materialized: false, destination: null, flushOperation: null };
  const ensure = (): pino.Logger => {
    if (!real) {
      const built = buildPinoLogger(options);
      real = built.logger;
      meta.materialized = true;
      meta.destination = built.destination;
    }
    return real;
  };

  const proxy = new Proxy(Object.create(null) as pino.Logger, {
    get(_target, prop) {
      const target = ensure();
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(ensure(), prop, value);
    },
    has(_target, prop) {
      return Reflect.has(ensure(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(ensure());
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(ensure(), prop);
    },
  });

  loggerMetaMap.set(proxy, meta);
  return proxy;
}

// 进程退出前等 sonic-boom 真正落盘。`pino.flush(cb)` 在 destination 还没 ready
// （fs.open 异步未完成）时会立刻回调 err=undefined 撒谎成功，但文件还是空的，所以
// 这里直接走 sonic-boom 的 ready 事件 + flushSync 路径。
//   - 未实例化（lazy proxy 没被访问过） → no-op，不会触发文件 IO 副作用。
//   - silent / stdout-only（destination 为 null） → no-op。
//   - timeoutMs 是兜底，确保异常情况下不会卡住进程退出。
export async function flushLogger(logger: pino.Logger, timeoutMs = 200): Promise<void> {
  const meta = loggerMetaMap.get(logger);
  if (!meta || !meta.materialized) return;
  const dest = meta.destination;
  if (!dest) return;
  const operation = meta.flushOperation ?? startFlushOperation(meta, dest);
  await waitForFlushOperation(operation, resolveFlushTimeout(timeoutMs));
}
