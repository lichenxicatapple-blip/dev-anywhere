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
    delete process.env.CLAUDE_BIN;
    delete process.env.CODEX_BIN;
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

  it("loads Agent CLI paths from the selected env and lets env vars override them", async () => {
    writeConfig({
      defaultEnv: "local",
      envs: {
        local: {
          relayUrl: "ws://localhost:3100",
          claudeBin: "/file/bin/claude",
          codexBin: "/file/bin/codex",
        },
      },
    });
    process.env.CLAUDE_BIN = "/env/bin/claude";

    const { buildProviderEnv, loadConfig } = await importConfig();
    const config = loadConfig();
    const providerEnv = buildProviderEnv(config, { PATH: "/usr/bin" });

    expect(config.claudeBin).toBe("/env/bin/claude");
    expect(config.codexBin).toBe("/file/bin/codex");
    expect(config.sources.claudeBin).toBe("env");
    expect(config.sources.codexBin).toBe("file");
    expect(providerEnv.CLAUDE_BIN).toBe("/env/bin/claude");
    expect(providerEnv.CODEX_BIN).toBe("/file/bin/codex");
    expect(config.agentCliSuggestions.claude).toEqual(["/env/bin/claude", "/file/bin/claude"]);
    expect(config.agentCliSuggestions.codex).toEqual(["/file/bin/codex"]);
  });

  it("persists Agent CLI paths into the selected env config", async () => {
    writeConfig({
      defaultEnv: "local",
      envs: {
        local: { relayUrl: "ws://localhost:3100" },
        cloud: { relayUrl: "wss://cloud.example.com" },
      },
    });

    const { loadConfig, saveAgentCliPath } = await importConfig();
    saveAgentCliPath("claude", "/home/dev/.local/bin/claude", { envName: "local" });

    const config = loadConfig();
    expect(config.claudeBin).toBe("/home/dev/.local/bin/claude");
    expect(config.sources.claudeBin).toBe("file");
    expect(config.agentCliSuggestions.claude).toEqual(["/home/dev/.local/bin/claude"]);
  });

  it("keeps user-entered Agent CLI paths as future suggestions", async () => {
    writeConfig({
      defaultEnv: "local",
      envs: {
        local: { relayUrl: "ws://localhost:3100" },
      },
    });

    const { loadConfig, saveAgentCliPath } = await importConfig();
    saveAgentCliPath("claude", "/opt/claude/v1/claude", { envName: "local" });
    saveAgentCliPath("claude", "/opt/claude/v2/claude", { envName: "local" });

    const config = loadConfig();
    expect(config.claudeBin).toBe("/opt/claude/v2/claude");
    expect(config.agentCliSuggestions.claude).toEqual([
      "/opt/claude/v2/claude",
      "/opt/claude/v1/claude",
    ]);
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
