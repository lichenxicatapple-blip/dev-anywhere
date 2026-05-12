import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, flushLogger } from "../logger.js";

describe("createLogger", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dev-anywhere-logger-"));
  });

  afterEach(() => {
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
});
