import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pino from "pino";
import { createLogger, flushLogger } from "../logger.js";

interface InspectableSonicDestination {
  _writing: boolean;
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
}

interface InspectableBoundedDestination {
  destination: InspectableSonicDestination;
  filePath: string;
  pendingRecord: string | null;
  rotating: boolean;
  rotationPromise: Promise<void> | null;
  rotationWaiters: Set<() => void>;
  saturated: boolean;
  flushSync(): void;
}

interface InspectableWritableDestination {
  writableLength: number;
  write(data: string): boolean | void;
}

interface InspectableStdoutDestination {
  destination: InspectableWritableDestination;
  droppedRecords: number;
  maxPendingBytes: number;
}

function inspectStreams(logger: pino.Logger): unknown[] {
  const internals = logger as unknown as Record<symbol, { streams: Array<{ stream: unknown }> }>;
  return internals[pino.symbols.streamSym].streams.map((entry) => entry.stream);
}

function inspectDestination(logger: pino.Logger): InspectableBoundedDestination {
  const destination = inspectStreams(logger).find(
    (stream): stream is InspectableBoundedDestination =>
      typeof stream === "object" && stream !== null && "filePath" in stream,
  );
  if (!destination) throw new Error("Bounded log destination not found");
  return destination;
}

function inspectStdoutDestination(logger: pino.Logger): InspectableStdoutDestination {
  const destination = inspectStreams(logger).find(
    (stream): stream is InspectableStdoutDestination =>
      typeof stream === "object" && stream !== null && "maxPendingBytes" in stream,
  );
  if (!destination) throw new Error("Bounded stdout destination not found");
  return destination;
}

function physicalLogFiles(logDir: string, name: string): string[] {
  return readdirSync(logDir).filter((entry) => {
    const path = join(logDir, entry);
    return (
      entry.startsWith(`${name}-`) && entry.endsWith(".log") && !lstatSync(path).isSymbolicLink()
    );
  });
}

describe("createLogger", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dev-anywhere-logger-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does not create logDir until a log method is called", () => {
    const logDir = join(tmp, "nested", "logs");
    const logger = createLogger({ name: "lazy", logDir });

    expect(existsSync(logDir)).toBe(false);
    expect(logger).toBeDefined();
  });

  it("creates logDir and writes a file on first .info call", () => {
    const logDir = join(tmp, "logs");
    const logger = createLogger({ name: "active", logDir, sync: true });

    logger.info({ hello: "world" }, "first log");

    expect(existsSync(logDir)).toBe(true);
    const files = readdirSync(logDir).filter((f) => f.endsWith(".log"));
    expect(files.some((f) => f.startsWith("active-"))).toBe(true);
  });

  it("atomically publishes one complete lease without leaving its candidate", () => {
    const logDir = join(tmp, "atomic-lease");
    const logger = createLogger({ name: "atomic-lease", logDir, sync: true });
    logger.info("materialize");

    const filePath = inspectDestination(logger).filePath;
    const leasePath = `${filePath}.active`;
    const lease = JSON.parse(readFileSync(leasePath, "utf-8")) as {
      version: number;
      pid: number;
      runId: string;
      fileName: string;
    };
    expect(lease).toMatchObject({
      version: 1,
      pid: process.pid,
      fileName: basename(filePath),
    });
    expect(lease.runId.length).toBeGreaterThan(0);
    expect(readdirSync(logDir).some((entry) => entry.includes(".active.candidate-"))).toBe(false);
  });

  it("removes its lease when destination construction fails synchronously", () => {
    const logDir = join(tmp, "sync-construction-failure");
    vi.spyOn(pino, "destination").mockImplementationOnce(() => {
      throw new Error("synthetic construction failure");
    });
    const logger = createLogger({ name: "sync-construction-failure", logDir, sync: true });

    expect(() => logger.info("materialize")).toThrow("synthetic construction failure");
    expect(readdirSync(logDir).filter((entry) => entry.includes(".active"))).toEqual([]);
  });

  it("removes its lease when the initial asynchronous open fails", () => {
    const logDir = join(tmp, "async-open-failure");
    const fakeDestination = Object.assign(new EventEmitter(), {
      fd: -1,
      _writing: true,
      write: () => true,
      flushSync: () => undefined,
    });
    vi.spyOn(pino, "destination").mockReturnValueOnce(
      fakeDestination as unknown as ReturnType<typeof pino.destination>,
    );
    const logger = createLogger({ name: "async-open-failure", logDir });
    logger.info("materialize");

    expect(readdirSync(logDir).filter((entry) => entry.endsWith(".active"))).toHaveLength(1);
    fakeDestination.emit("error", new Error("synthetic async open failure"));
    expect(readdirSync(logDir).filter((entry) => entry.includes(".active"))).toEqual([]);
  });

  it("gives same-name loggers independent active files and byte counters", async () => {
    const logDir = join(tmp, "same-name");
    const maxFileBytes = 1_024;
    const first = createLogger({
      name: "shared-name",
      logDir,
      sync: true,
      maxFileBytes,
      maxFilesPerRun: 2,
    });
    const second = createLogger({
      name: "shared-name",
      logDir,
      sync: true,
      maxFileBytes,
      maxFilesPerRun: 2,
    });

    for (let index = 0; index < 5; index += 1) {
      first.info({ owner: "first", index, payload: "x".repeat(80) }, "same-name-line");
      second.info({ owner: "second", index, payload: "x".repeat(80) }, "same-name-line");
    }
    await Promise.all([flushLogger(first, 1_000), flushLogger(second, 1_000)]);

    const firstPath = inspectDestination(first).filePath;
    const secondPath = inspectDestination(second).filePath;
    expect(firstPath).not.toBe(secondPath);
    expect(readlinkSync(join(logDir, "shared-name.log"))).toBe(basename(secondPath));
    for (const file of physicalLogFiles(logDir, "shared-name")) {
      expect(Buffer.byteLength(readFileSync(join(logDir, file)))).toBeLessThanOrEqual(maxFileBytes);
    }
  });

  it("silent mode also avoids fs side effects until first call (and never writes)", () => {
    const logDir = join(tmp, "silent");
    const logger = createLogger({ name: "silent", logDir, silent: true });

    expect(existsSync(logDir)).toBe(false);

    logger.info("ignored");

    expect(existsSync(logDir)).toBe(false);
  });

  it("supports child() and forwards level changes", () => {
    const logger = createLogger({ name: "child-test", logDir: tmp, level: "debug", sync: true });
    const child = logger.child({ scope: "unit" });

    expect(typeof child.info).toBe("function");
    logger.level = "warn";
    expect(logger.level).toBe("warn");
  });

  it("flushLogger is a no-op on a logger that was never used (does not materialize)", async () => {
    const logDir = join(tmp, "untouched");
    const logger = createLogger({ name: "untouched", logDir });

    await flushLogger(logger);

    // 关键：flushLogger 不应触发懒构造，否则空命令路径会留下空 log 文件。
    expect(existsSync(logDir)).toBe(false);
  });

  it("flushLogger is a no-op on a silent logger", async () => {
    const logDir = join(tmp, "silent-flush");
    const logger = createLogger({ name: "silent-flush", logDir, silent: true });
    logger.info("ignored");

    await flushLogger(logger);

    expect(existsSync(logDir)).toBe(false);
  });

  it("flushLogger drains pending async writes to disk before returning", async () => {
    const logDir = join(tmp, "async-flush");
    // 不传 sync，模拟生产 async destination —— sonic-boom 的 fs.open 是异步的，
    // 写入后立刻读文件可能为空。flushLogger 必须等 ready 事件再 flushSync。
    const logger = createLogger({ name: "async-flush", logDir });

    logger.info({ k: 1 }, "line-a");
    logger.info({ k: 2 }, "line-b");

    await flushLogger(logger, 1000);

    const files = readdirSync(logDir).filter(
      (f) => f.startsWith("async-flush-") && f.endsWith(".log"),
    );
    expect(files.length).toBe(1);
    const content = readFileSync(join(logDir, files[0]), "utf-8");
    expect(content).toContain("line-a");
    expect(content).toContain("line-b");
  });

  it("removes ready, drain, error, and timeout listeners after every flush outcome", async () => {
    const logger = createLogger({ name: "flush-listeners", logDir: join(tmp, "listeners") });
    logger.info("open-destination");
    const sonic = inspectDestination(logger).destination;
    const initialErrorListeners = sonic.listenerCount("error");

    await flushLogger(logger, 1_000);
    expect(sonic.listenerCount("ready")).toBe(0);
    expect(sonic.listenerCount("drain")).toBe(0);
    expect(sonic.listenerCount("error")).toBe(initialErrorListeners);

    sonic._writing = true;
    await flushLogger(logger, 5);
    sonic._writing = false;
    sonic.emit("drain");
    await flushLogger(logger, 1_000);
    expect(sonic.listenerCount("ready")).toBe(0);
    expect(sonic.listenerCount("drain")).toBe(0);
    expect(sonic.listenerCount("error")).toBe(initialErrorListeners);

    sonic._writing = true;
    const failedFlush = flushLogger(logger, 1_000);
    setTimeout(() => sonic.emit("error", new Error("synthetic flush failure")), 0);
    await failedFlush;
    sonic._writing = false;
    expect(sonic.listenerCount("ready")).toBe(0);
    expect(sonic.listenerCount("drain")).toBe(0);
    // Pino removes its own first-error filter after forwarding a non-EPIPE failure. The bounded
    // destination listener remains; flushLogger must not leave an additional listener behind.
    expect(sonic.listenerCount("error")).toBe(initialErrorListeners - 1);
  });

  it("coalesces concurrent flushes into one destination flush", async () => {
    const logger = createLogger({ name: "concurrent-flush", logDir: join(tmp, "concurrent") });
    logger.info("open-destination");
    await flushLogger(logger, 1_000);

    const destination = inspectDestination(logger);
    const originalFlushSync = destination.flushSync.bind(destination);
    let flushCount = 0;
    destination.flushSync = () => {
      flushCount += 1;
      originalFlushSync();
    };

    logger.info({ payload: "x".repeat(4_096) }, "pending-write");
    await Promise.all(Array.from({ length: 50 }, () => flushLogger(logger, 1_000)));

    expect(flushCount).toBe(1);
  });

  it("keeps a later caller's shorter timeout independent from a shared flush", async () => {
    const logger = createLogger({ name: "flush-deadlines", logDir: join(tmp, "deadlines") });
    logger.info("open-destination");
    await flushLogger(logger, 1_000);

    const sonic = inspectDestination(logger).destination;
    sonic._writing = true;
    let longSettled = false;
    let shortSettled = false;
    const longFlush = flushLogger(logger, 200).then(() => {
      longSettled = true;
    });
    const shortFlush = flushLogger(logger, 5).then(() => {
      shortSettled = true;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(shortSettled).toBe(true);
    expect(longSettled).toBe(false);

    sonic._writing = false;
    sonic.emit("drain");
    await Promise.all([longFlush, shortFlush]);
    expect(longSettled).toBe(true);
  });

  it("does not keep a child process alive for the internal flush deadline", () => {
    const loggerModuleUrl = new URL("../logger.ts", import.meta.url).href;
    const childLogDir = join(tmp, "unref-child");
    const script = `
      import pino from "pino";
      import { createLogger, flushLogger } from ${JSON.stringify(loggerModuleUrl)};
      const logger = createLogger({
        name: "unref-child",
        logDir: ${JSON.stringify(childLogDir)},
        sync: true,
      });
      logger.info("materialize");
      await flushLogger(logger, 1000);
      const streams = logger[pino.symbols.streamSym].streams.map((entry) => entry.stream);
      const bounded = streams.find((stream) => stream && typeof stream === "object" && "filePath" in stream);
      bounded.destination._writing = true;
      await flushLogger(logger, 5);
    `;

    const startedAt = Date.now();
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf-8", timeout: 2_000, cwd: new URL("../../", import.meta.url) },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("rotates a live log before any file can grow past its byte limit", async () => {
    const logDir = join(tmp, "bounded");
    const maxFileBytes = 1_024;
    const logger = createLogger({
      name: "bounded",
      logDir,
      sync: true,
      maxFileBytes,
      maxFilesPerRun: 3,
      maxRecordBytes: 512,
    });

    for (let index = 0; index < 200; index += 1) {
      logger.info({ index, payload: "x".repeat(80) }, "bounded-line");
    }
    await flushLogger(logger, 1_000);

    const files = readdirSync(logDir).filter((entry) => {
      const path = join(logDir, entry);
      return (
        entry.startsWith("bounded-") && entry.endsWith(".log") && !lstatSync(path).isSymbolicLink()
      );
    });
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
    for (const file of files) {
      const content = readFileSync(join(logDir, file), "utf-8");
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(maxFileBytes);
      for (const line of content.trim().split("\n")) {
        if (line) expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("waits for synchronous rotation and its dropped-record summary before flush returns", async () => {
    const logDir = join(tmp, "sync-rotation-flush");
    const logger = createLogger({
      name: "sync-rotation-flush",
      logDir,
      sync: true,
      maxFileBytes: 1_024,
      maxFilesPerRun: 3,
      maxRecordBytes: 512,
    });

    for (let index = 0; index < 200; index += 1) {
      logger.info({ index, payload: "x".repeat(80) }, "rotation-line");
    }
    await flushLogger(logger, 1_000);

    const files = physicalLogFiles(logDir, "sync-rotation-flush");
    const activeFile = files.find((file) => !/\.\d+\.log$/.test(file));
    expect(activeFile).toBeDefined();
    const activeRecords = readFileSync(join(logDir, activeFile!), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg?: string; dropped?: number });
    expect(activeRecords.filter((record) => record.msg === "rotation-line")).toHaveLength(1);

    const records = files
      .flatMap((file) => readFileSync(join(logDir, file), "utf-8").trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg?: string; dropped?: number });
    expect(records).toContainEqual(
      expect.objectContaining({
        msg: "Log records were dropped while rotating the active file",
        dropped: expect.any(Number),
      }),
    );
  });

  it("fails a rotation closed when the old destination never drains", async () => {
    const logDir = join(tmp, "stalled-rotation");
    const logger = createLogger({
      name: "stalled-rotation",
      logDir,
      sync: true,
      maxFileBytes: 1_024,
      maxRecordBytes: 512,
    });
    logger.info("open-destination");
    await flushLogger(logger, 1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const destination = inspectDestination(logger);
    const sonic = destination.destination;
    const initialErrorListeners = sonic.listenerCount("error");
    vi.useFakeTimers();
    try {
      sonic._writing = true;
      for (let index = 0; index < 20; index += 1) {
        logger.info({ index, payload: "x".repeat(80) }, "stalled-line");
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(destination.rotationPromise).not.toBeNull();

      await vi.advanceTimersByTimeAsync(6_000);
      expect(destination.rotationPromise).toBeNull();
      expect(destination.rotating).toBe(false);
      expect(destination.saturated).toBe(true);
      expect(destination.pendingRecord).toBeNull();
      expect(destination.rotationWaiters.size).toBe(0);
      expect(sonic.listenerCount("ready")).toBe(0);
      expect(sonic.listenerCount("drain")).toBe(0);
      expect(sonic.listenerCount("error")).toBe(initialErrorListeners);
    } finally {
      sonic._writing = false;
      vi.useRealTimers();
    }
  });

  it("replaces an oversized serialized record with a bounded valid JSON diagnostic", async () => {
    const logDir = join(tmp, "oversized");
    const logger = createLogger({
      name: "oversized",
      logDir,
      sync: true,
      maxFileBytes: 1_024,
      maxRecordBytes: 256,
    });

    logger.warn({ payload: "x".repeat(20_000) }, "oversized-line");
    await flushLogger(logger, 1_000);

    const file = readdirSync(logDir).find(
      (entry) => entry.startsWith("oversized-") && entry.endsWith(".log"),
    );
    expect(file).toBeDefined();
    const content = readFileSync(join(logDir, file!), "utf-8");
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1_024);
    expect(JSON.parse(content)).toMatchObject({
      msg: "Log entry omitted because it exceeded the configured byte limit",
    });
  });

  it("keeps asynchronous files bounded when a burst is followed by slow writes", async () => {
    const logDir = join(tmp, "async-bounded");
    const maxFileBytes = 2_048;
    const logger = createLogger({
      name: "async-bounded",
      logDir,
      maxFileBytes,
      maxFilesPerRun: 5,
      maxRecordBytes: 1_024,
    });

    logger.info("open-destination");
    await flushLogger(logger, 1_000);
    for (let index = 0; index < 13; index += 1) {
      logger.info({ phase: 1, index, payload: "x".repeat(80) }, "async-bounded-line");
    }
    await flushLogger(logger, 1_000);
    for (let index = 0; index < 11; index += 1) {
      logger.info({ phase: 2, index, payload: "x".repeat(80) }, "async-bounded-line");
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    await flushLogger(logger, 1_000);

    const files = physicalLogFiles(logDir, "async-bounded");
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(5);
    for (const file of files) {
      expect(Buffer.byteLength(readFileSync(join(logDir, file)))).toBeLessThanOrEqual(maxFileBytes);
    }
  });

  it("fails closed instead of deleting a log protected by a malformed lease", async () => {
    const logDir = join(tmp, "malformed-lease");
    const first = createLogger({ name: "malformed", logDir, sync: true, retention: 1 });
    first.info("protected-log");
    await flushLogger(first, 1_000);
    const firstPath = inspectDestination(first).filePath;
    writeFileSync(`${firstPath}.active`, "{partial-json", "utf-8");

    const second = createLogger({ name: "malformed", logDir, sync: true, retention: 1 });
    second.info("trigger-prune");
    await flushLogger(second, 1_000);

    expect(existsSync(firstPath)).toBe(true);
    expect(readFileSync(`${firstPath}.active`, "utf-8")).toBe("{partial-json");
  });

  it("fails closed when a log lease cannot be read", async () => {
    const logDir = join(tmp, "unreadable-lease");
    const first = createLogger({ name: "unreadable", logDir, sync: true, retention: 1 });
    first.info("protected-log");
    await flushLogger(first, 1_000);
    const firstPath = inspectDestination(first).filePath;
    unlinkSync(`${firstPath}.active`);
    mkdirSync(`${firstPath}.active`);

    const second = createLogger({ name: "unreadable", logDir, sync: true, retention: 1 });
    second.info("trigger-prune");
    await flushLogger(second, 1_000);

    expect(existsSync(firstPath)).toBe(true);
    expect(lstatSync(`${firstPath}.active`).isDirectory()).toBe(true);
  });

  it("reclaims valid dead-owner lease artifacts that have no corresponding log", () => {
    const logDir = join(tmp, "orphan-leases");
    mkdirSync(logDir);
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(child.pid).toBeTypeOf("number");

    const orphanFileName = "orphan-missing-final.log";
    const candidateFileName = "orphan-missing-candidate.log";
    const malformedFileName = "orphan-malformed.log";
    const orphanLease = join(logDir, `${orphanFileName}.active`);
    const candidateLease = join(logDir, `${candidateFileName}.active.candidate-${child.pid}-test`);
    const malformedLease = join(logDir, `${malformedFileName}.active`);
    writeFileSync(
      orphanLease,
      `${JSON.stringify({
        version: 1,
        pid: child.pid,
        runId: "orphan-final",
        fileName: orphanFileName,
      })}\n`,
    );
    writeFileSync(
      candidateLease,
      `${JSON.stringify({
        version: 1,
        pid: child.pid,
        runId: "orphan-candidate",
        fileName: candidateFileName,
      })}\n`,
    );
    writeFileSync(malformedLease, "{partial-json");

    const logger = createLogger({ name: "orphan", logDir, sync: true, retention: 0 });
    logger.info("trigger-orphan-prune");

    expect(existsSync(orphanLease)).toBe(false);
    expect(existsSync(candidateLease)).toBe(false);
    expect(existsSync(malformedLease)).toBe(true);
  });

  it("retention preserves another live writer and lets it rotate afterwards", async () => {
    const logDir = join(tmp, "live-lease");
    const maxFileBytes = 1_024;
    const first = createLogger({
      name: "leased",
      logDir,
      sync: true,
      retention: 1,
      maxFileBytes,
      maxRecordBytes: 512,
    });
    first.info({ owner: "first" }, "first-before-prune");
    await flushLogger(first, 1_000);
    const firstPath = inspectDestination(first).filePath;

    const second = createLogger({
      name: "leased",
      logDir,
      sync: true,
      retention: 1,
      maxFileBytes,
      maxRecordBytes: 512,
    });
    second.info({ owner: "second" }, "second-writer");
    await flushLogger(second, 1_000);
    const secondPath = inspectDestination(second).filePath;

    expect(existsSync(firstPath)).toBe(true);
    expect(readlinkSync(join(logDir, "leased.log"))).toBe(basename(secondPath));
    for (let index = 0; index < 20; index += 1) {
      first.info({ owner: "first", index, payload: "x".repeat(80) }, "first-after-prune");
    }
    await flushLogger(first, 1_000);

    expect(existsSync(firstPath)).toBe(true);
    expect(readFileSync(firstPath, "utf-8")).toContain("first-after-prune");
    for (const file of physicalLogFiles(logDir, "leased")) {
      expect(Buffer.byteLength(readFileSync(join(logDir, file)))).toBeLessThanOrEqual(maxFileBytes);
    }
  });

  it("reclaims a crashed writer's stale lease during retention", async () => {
    const logDir = join(tmp, "stale-lease");
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(child.pid).toBeTypeOf("number");

    const staleFile = join(logDir, "reclaimed-stale-run.log");
    const staleLease = `${staleFile}.active`;
    // Materialize the directory without adding a competing log file yet.
    const logger = createLogger({ name: "reclaimed", logDir, sync: true, retention: 1 });
    logger.info("create-directory");
    await flushLogger(logger, 1_000);
    writeFileSync(staleFile, "stale\n");
    writeFileSync(
      staleLease,
      `${JSON.stringify({
        version: 1,
        pid: child.pid,
        runId: "stale-run",
        fileName: basename(staleFile),
      })}\n`,
    );

    const pruningLogger = createLogger({ name: "reclaimed", logDir, sync: true, retention: 1 });
    pruningLogger.info("trigger-prune");
    await flushLogger(pruningLogger, 1_000);

    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(staleLease)).toBe(false);
  });

  it("bounds stdout backlog and reports dropped records without adding stream listeners", async () => {
    const logger = createLogger({
      name: "bounded-stdout",
      logDir: join(tmp, "stdout"),
      sync: true,
      stdout: true,
    });
    const stdoutDestination = inspectStdoutDestination(logger);
    const processDrainListeners = process.stdout.listenerCount("drain");
    const processErrorListeners = process.stdout.listenerCount("error");
    const writes: string[] = [];
    const blockedDestination: InspectableWritableDestination = {
      writableLength: 0,
      write(data) {
        writes.push(data);
        this.writableLength += Buffer.byteLength(data);
        return false;
      },
    };
    stdoutDestination.destination = blockedDestination;

    for (let index = 0; index < 5_000; index += 1) {
      logger.info({ index, payload: "x".repeat(512) }, "stdout-storm");
    }
    expect(blockedDestination.writableLength).toBeLessThanOrEqual(
      stdoutDestination.maxPendingBytes,
    );
    expect(stdoutDestination.droppedRecords).toBeGreaterThan(0);

    blockedDestination.writableLength = 0;
    logger.info("stdout-recovered");
    expect(stdoutDestination.droppedRecords).toBe(0);
    expect(writes.some((record) => record.includes("stdout was backpressured"))).toBe(true);
    expect(process.stdout.listenerCount("drain")).toBe(processDrainListeners);
    expect(process.stdout.listenerCount("error")).toBe(processErrorListeners);
    await flushLogger(logger, 1_000);
  });

  it("drops diagnostics that cannot fit inside an extremely small file limit", async () => {
    const logDir = join(tmp, "tiny-limit");
    const maxFileBytes = 64;
    const logger = createLogger({
      name: "tiny-limit",
      logDir,
      sync: true,
      maxFileBytes,
      maxRecordBytes: 32,
    });

    logger.warn({ payload: "x".repeat(20_000) }, "oversized-line");
    await flushLogger(logger, 1_000);

    for (const file of physicalLogFiles(logDir, "tiny-limit")) {
      expect(Buffer.byteLength(readFileSync(join(logDir, file)))).toBeLessThanOrEqual(maxFileBytes);
    }
  });
});
