import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createLogger: vi.fn((options: { name: string }) => ({ name: options.name })),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

vi.mock("@dev-anywhere/shared/logger", () => ({ createLogger: mocks.createLogger }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync, readFileSync: mocks.readFileSync }));
vi.mock("#src/common/paths.js", () => ({
  CONFIG_PATH: "/unused/config.json",
  LOG_DIR: "/unused/logs",
}));
vi.mock("#src/common/runtime-env.js", () => ({
  loadProxyRuntimeEnv: () => ({ logLevel: undefined, isVitest: false }),
  VALID_LOG_LEVELS: ["trace", "debug", "info", "warn", "error", "fatal", "silent"],
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe("preview worker logger isolation", () => {
  it("creates only the preview-worker logger and aliases both otherwise eager exports", async () => {
    vi.stubEnv("DEV_ANYWHERE_PROCESS_ROLE", "preview-worker");

    const { serviceLogger, terminalLogger, autoUpdateLogger } =
      await import("#src/common/logger.js");

    expect(mocks.createLogger).toHaveBeenCalledExactlyOnceWith({
      name: "preview-worker",
      level: "info",
      logDir: "/unused/logs",
      silent: false,
    });
    expect(terminalLogger).toBe(serviceLogger);
    expect(autoUpdateLogger).toBe(serviceLogger);
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });

  it("keeps all three independent loggers and their default levels for an ordinary process", async () => {
    vi.stubEnv("DEV_ANYWHERE_PROCESS_ROLE", undefined);

    const { serviceLogger, terminalLogger, autoUpdateLogger } =
      await import("#src/common/logger.js");

    expect(mocks.createLogger.mock.calls).toEqual([
      [{ name: "service", level: "info", logDir: "/unused/logs", silent: false }],
      [{ name: "terminal", level: "debug", logDir: "/unused/logs", silent: false }],
      [{ name: "auto-update", level: "info", logDir: "/unused/logs", silent: false }],
    ]);
    expect(terminalLogger).not.toBe(serviceLogger);
    expect(autoUpdateLogger).not.toBe(serviceLogger);
    expect(autoUpdateLogger).not.toBe(terminalLogger);
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });
});
