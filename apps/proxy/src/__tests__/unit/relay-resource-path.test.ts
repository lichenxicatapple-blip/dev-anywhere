import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#src/common/config.js", () => ({ saveAgentCliPath: vi.fn() }));

import { saveAgentCliPath } from "#src/common/config.js";
import { RelayResourceHandlers } from "#src/serve/relay-resource-handlers.js";

const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function updatePath(path: string) {
  const sent: Array<Record<string, unknown>> = [];
  const handlers = new RelayResourceHandlers({
    relaySend: (raw) => sent.push(JSON.parse(raw)),
    controlHandlers: {} as never,
    sessionManager: {} as never,
    getProviderEnv: () => ({}),
    getAgentCliSuggestions: () => ({}),
    setAgentCliPath: vi.fn(),
  });
  handlers.onAgentCliConfigUpdate({
    type: "agent_cli_config_update",
    requestId: "path",
    provider: "claude",
    path,
  });
  return sent[0];
}

describe("Agent CLI path configuration", () => {
  it("accepts an executable absolute path on the actual host platform", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-anywhere-cli-path-"));
    roots.push(root);
    const path = join(root, process.platform === "win32" ? "agent.exe" : "agent");
    writeFileSync(path, "fixture");
    chmodSync(path, 0o755);
    expect(updatePath(path)).not.toHaveProperty("errorCode");
    expect(saveAgentCliPath).toHaveBeenCalledWith("claude", path);
  });

  it.each(["agent", "./agent", "C:agent", "C:"])("rejects relative path %s", (path) => {
    expect(updatePath(path)).toHaveProperty("errorCode", "INVALID_PATH");
    expect(saveAgentCliPath).not.toHaveBeenCalled();
  });
});
