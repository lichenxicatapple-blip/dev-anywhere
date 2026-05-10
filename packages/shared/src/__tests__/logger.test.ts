import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";

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
});
