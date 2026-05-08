import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
let homeDir = "";

async function importConfig() {
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:os")>()),
    homedir: () => homeDir,
  }));
  return import("../../common/config.js");
}

function writeConfig(content: unknown): void {
  const configDir = join(homeDir, ".dev-anywhere");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(content), "utf8");
}

describe("proxy config env selection", () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "dev-anywhere-config-"));
    process.env = { ...originalEnv, HOME: homeDir };
    delete process.env.RELAY_URL;
    delete process.env.RELAY_PROXY_TOKEN;
    delete process.env.DEV_ANYWHERE_HOOK_PORT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock("node:os");
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("uses defaultEnv when --env is not provided", async () => {
    writeConfig({
      defaultEnv: "cloud",
      envs: {
        local: { relayUrl: "ws://localhost:3100" },
        cloud: { relayUrl: "wss://cloud.example.com", relayToken: "secret" },
      },
    });

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.envName).toBe("cloud");
    expect(config.relayUrl).toBe("wss://cloud.example.com");
    expect(config.relayToken).toBe("secret");
    expect(config.sources.envName).toBe("file");
  });

  it("uses requested env from serve --env", async () => {
    writeConfig({
      defaultEnv: "local",
      envs: {
        local: { relayUrl: "ws://localhost:3100" },
        cloud: { relayUrl: "wss://cloud.example.com" },
      },
    });

    const { loadConfig } = await importConfig();
    const config = loadConfig({ envName: "cloud" });

    expect(config.envName).toBe("cloud");
    expect(config.relayUrl).toBe("wss://cloud.example.com");
    expect(config.sources.envName).toBe("cli");
  });

  it("lets RELAY_URL temporarily override the selected env", async () => {
    writeConfig({
      defaultEnv: "cloud",
      envs: {
        cloud: { relayUrl: "wss://cloud.example.com", relayToken: "file-token" },
      },
    });
    process.env.RELAY_URL = "ws://override.local:3100";

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.relayUrl).toBe("ws://override.local:3100");
    expect(config.relayToken).toBe("file-token");
    expect(config.sources.relayUrl).toBe("env");
    expect(config.sources.relayToken).toBe("file");
  });

  it("still reads the single-env config shape", async () => {
    writeConfig({ relayUrl: "ws://single.local:3100" });

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.envName).toBeUndefined();
    expect(config.relayUrl).toBe("ws://single.local:3100");
    expect(config.sources.envName).toBe("single");
  });

  it("throws a clear error for unknown env names", async () => {
    writeConfig({
      defaultEnv: "local",
      envs: {
        local: { relayUrl: "ws://localhost:3100" },
      },
    });

    const { loadConfig } = await importConfig();

    expect(() => loadConfig({ envName: "cloud" })).toThrow(
      'Unknown config env "cloud". Available envs: local',
    );
  });
});
