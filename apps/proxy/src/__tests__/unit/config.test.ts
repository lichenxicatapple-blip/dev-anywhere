import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
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

const currentConfig = {
  defaultProfile: "default",
  profiles: {
    default: { relay: "cloud" },
    local: { relay: "local" },
  },
  relays: {
    local: { url: "ws://localhost:3100" },
    cloud: { url: "wss://cloud.example.com", proxyToken: "secret" },
  },
};

describe("proxy config relay selection", () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "dev-anywhere-config-"));
    process.env = { ...originalEnv, HOME: homeDir };
    delete process.env.RELAY_URL;
    delete process.env.RELAY_PROXY_TOKEN;
    delete process.env.DEV_ANYWHERE_HOOK_PORT;
    delete process.env.CLAUDE_BIN;
    delete process.env.CODEX_BIN;
    process.argv = ["node", "dev-anywhere"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    vi.doUnmock("node:os");
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("uses defaultProfile and its bound relay when no CLI profile or relay override is provided", async () => {
    writeConfig(currentConfig);

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.profileName).toBe("default");
    expect(config.relayName).toBe("cloud");
    expect(config.relayUrl).toBe("wss://cloud.example.com");
    expect(config.relayToken).toBe("secret");
    expect(config.sources.relayName).toBe("profile");
  });

  it("uses --profile to select another profile and that profile's relay", async () => {
    writeConfig(currentConfig);

    process.argv = ["node", "dev-anywhere", "--profile", "local", "serve", "status"];
    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.profileName).toBe("local");
    expect(config.relayName).toBe("local");
    expect(config.relayUrl).toBe("ws://localhost:3100");
    expect(config.relayToken).toBeUndefined();
    expect(config.sources.relayName).toBe("profile");
  });

  it("uses defaultProfile from config when no CLI or env profile is provided", async () => {
    writeConfig({
      ...currentConfig,
      defaultProfile: "local",
    });

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.profileName).toBe("local");
    expect(config.relayName).toBe("local");
  });

  it("lets serve --relay override the profile-bound relay", async () => {
    writeConfig(currentConfig);
    process.argv = ["node", "dev-anywhere", "--profile", "local", "serve", "start"];

    const { loadConfig } = await importConfig();
    const config = loadConfig({ relayName: "cloud" });

    expect(config.profileName).toBe("local");
    expect(config.relayName).toBe("cloud");
    expect(config.relayUrl).toBe("wss://cloud.example.com");
    expect(config.sources.relayName).toBe("cli");
  });

  it("lets RELAY_URL temporarily override the selected relay URL", async () => {
    writeConfig(currentConfig);
    process.env.RELAY_URL = "ws://override.local:3100";

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.relayName).toBe("cloud");
    expect(config.relayUrl).toBe("ws://override.local:3100");
    expect(config.relayToken).toBe("secret");
    expect(config.sources.relayUrl).toBe("env");
    expect(config.sources.relayToken).toBe("file");
  });

  it("loads Agent CLI paths from top-level agentCli and lets env vars override them", async () => {
    writeConfig({
      ...currentConfig,
      agentCli: {
        claudeBin: "/file/bin/claude",
        codexBin: "/file/bin/codex",
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

  it("persists Agent CLI paths into top-level agentCli config", async () => {
    writeConfig(currentConfig);

    const { loadConfig, saveAgentCliPath } = await importConfig();
    saveAgentCliPath("claude", "/home/dev/.local/bin/claude");

    const configFile = JSON.parse(
      readFileSync(join(homeDir, ".dev-anywhere", "config.json"), "utf8"),
    );

    expect(configFile.agentCli.claudeBin).toBe("/home/dev/.local/bin/claude");

    const config = loadConfig();
    expect(config.claudeBin).toBe("/home/dev/.local/bin/claude");
    expect(config.sources.claudeBin).toBe("file");
    expect(config.agentCliSuggestions.claude).toEqual(["/home/dev/.local/bin/claude"]);
  });

  it("keeps user-entered Agent CLI paths as future suggestions", async () => {
    writeConfig(currentConfig);

    const { loadConfig, saveAgentCliPath } = await importConfig();
    saveAgentCliPath("claude", "/opt/claude/v1/claude");
    saveAgentCliPath("claude", "/opt/claude/v2/claude");

    const config = loadConfig();
    expect(config.claudeBin).toBe("/opt/claude/v2/claude");
    expect(config.agentCliSuggestions.claude).toEqual([
      "/opt/claude/v2/claude",
      "/opt/claude/v1/claude",
    ]);
  });

  it("rejects the legacy envs/defaultEnv config shape", async () => {
    writeConfig({
      defaultEnv: "local",
      envs: {
        local: { relayUrl: "ws://localhost:3100" },
      },
    });

    const { loadConfig } = await importConfig();

    expect(() => loadConfig()).toThrow(/expected "profiles" and "relays"/);
  });

  it("throws a clear error for unknown relay names", async () => {
    writeConfig(currentConfig);

    const { loadConfig } = await importConfig();

    expect(() => loadConfig({ relayName: "staging" })).toThrow(
      'Unknown relay "staging". Available relays: cloud, local',
    );
  });
});
