import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChildProcessFake } from "./test-fakes.js";

let mockChild: ReturnType<typeof createChildProcessFake>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

describe("ToolWhitelist", () => {
  let ToolWhitelist: typeof import("#src/worker/json-session.js").ToolWhitelist;

  beforeEach(async () => {
    const mod = await import("#src/worker/json-session.js");
    ToolWhitelist = mod.ToolWhitelist;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not auto-approve when toolName is NOT in the whitelist", () => {
    const wl = new ToolWhitelist();
    expect(wl.has("Bash")).toBe(false);
  });

  it("clearWhitelist removes all entries", () => {
    const wl = new ToolWhitelist();
    wl.add("Bash");
    wl.add("Write");
    wl.clear();
    expect(wl.has("Bash")).toBe(false);
    expect(wl.has("Write")).toBe(false);
  });
});

describe("createRelayApprovalStrategy", () => {
  let createRelayApprovalStrategy: typeof import("#src/worker/json-session.js").createRelayApprovalStrategy;
  let ToolWhitelist: typeof import("#src/worker/json-session.js").ToolWhitelist;

  beforeEach(async () => {
    const mod = await import("#src/worker/json-session.js");
    createRelayApprovalStrategy = mod.createRelayApprovalStrategy;
    ToolWhitelist = mod.ToolWhitelist;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a function that calls the provided forwardToRelay callback", async () => {
    const wl = new ToolWhitelist();
    const forwardToRelay = vi.fn().mockResolvedValue({ behavior: "allow" as const });
    const strategy = createRelayApprovalStrategy(wl, forwardToRelay);

    const result = await strategy("Bash", { command: "ls" });
    expect(forwardToRelay).toHaveBeenCalledWith("Bash", { command: "ls" });
    expect(result.behavior).toBe("allow");
  });

  it("auto-approves when toolName is whitelisted without calling forwardToRelay", async () => {
    const wl = new ToolWhitelist();
    wl.add("Bash");
    const forwardToRelay = vi.fn().mockResolvedValue({ behavior: "deny" as const });
    const strategy = createRelayApprovalStrategy(wl, forwardToRelay);

    const result = await strategy("Bash", { command: "ls" });
    expect(forwardToRelay).not.toHaveBeenCalled();
    expect(result.behavior).toBe("allow");
    expect(result.message).toContain("whitelist");
  });

  it("auto-approves later same-tool requests after the session whitelist is updated", async () => {
    const wl = new ToolWhitelist();
    const forwardToRelay = vi
      .fn()
      .mockResolvedValueOnce({ behavior: "allow" as const, message: "approved remotely" })
      .mockResolvedValueOnce({ behavior: "deny" as const, message: "needs approval" });
    const strategy = createRelayApprovalStrategy(wl, forwardToRelay);

    const firstBash = await strategy("Bash", { command: "ls" });
    expect(firstBash).toEqual({ behavior: "allow", message: "approved remotely" });
    expect(forwardToRelay).toHaveBeenCalledTimes(1);
    expect(forwardToRelay).toHaveBeenLastCalledWith("Bash", { command: "ls" });

    wl.add("Bash");

    const secondBash = await strategy("Bash", { command: "pwd" });
    expect(secondBash).toEqual({
      behavior: "allow",
      message: "Auto-approved by session whitelist",
    });
    expect(forwardToRelay).toHaveBeenCalledTimes(1);

    const write = await strategy("Write", { file_path: "/tmp/a" });
    expect(write).toEqual({ behavior: "deny", message: "needs approval" });
    expect(forwardToRelay).toHaveBeenCalledTimes(2);
    expect(forwardToRelay).toHaveBeenLastCalledWith("Write", { file_path: "/tmp/a" });
  });
});

describe("JsonSession claudeSessionId capture", () => {
  let JsonSession: typeof import("#src/worker/json-session.js").JsonSession;

  beforeEach(async () => {
    mockChild = createChildProcessFake();
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
    const mod = await import("#src/worker/json-session.js");
    JsonSession = mod.JsonSession;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures Claude session ID from system event", async () => {
    const session = new JsonSession({
      onEvent: () => {},
    });
    session.start();

    const systemEvent = {
      type: "system",
      subtype: "init",
      session_id: "claude-sess-456",
      tools: [],
      model: "claude-4",
    };
    mockChild.mockStdout.write(JSON.stringify(systemEvent) + "\n");

    await new Promise((r) => setTimeout(r, 50));
    expect(session.getClaudeSessionId()).toBe("claude-sess-456");
  });

  it("returns null when no system event received", () => {
    const session = new JsonSession();
    expect(session.getClaudeSessionId()).toBeNull();
  });
});
