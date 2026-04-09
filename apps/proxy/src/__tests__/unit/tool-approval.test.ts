import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// 模拟 child_process.spawn 返回的子进程
function createMockChild(): ChildProcess & {
  mockStdout: PassThrough;
  mockStdin: PassThrough;
  mockStderr: PassThrough;
} {
  const emitter = new EventEmitter();
  const mockStdout = new PassThrough();
  const mockStdin = new PassThrough();
  const mockStderr = new PassThrough();

  const child = Object.assign(emitter, {
    stdin: mockStdin,
    stdout: mockStdout,
    stderr: mockStderr,
    pid: 12345,
    killed: false,
    connected: true,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "",
    kill: vi.fn().mockReturnValue(true),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    stdio: [mockStdin, mockStdout, mockStderr, null, null] as ChildProcess["stdio"],
    [Symbol.dispose]: vi.fn(),
    mockStdout,
    mockStdin,
    mockStderr,
  }) as unknown as ChildProcess & {
    mockStdout: PassThrough;
    mockStdin: PassThrough;
    mockStderr: PassThrough;
  };

  return child;
}

let mockChild: ReturnType<typeof createMockChild>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

describe("ToolWhitelist", () => {
  let ToolWhitelist: typeof import("#src/json-session.js").ToolWhitelist;

  beforeEach(async () => {
    const mod = await import("#src/json-session.js");
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
  let createRelayApprovalStrategy: typeof import("#src/json-session.js").createRelayApprovalStrategy;
  let ToolWhitelist: typeof import("#src/json-session.js").ToolWhitelist;

  beforeEach(async () => {
    const mod = await import("#src/json-session.js");
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
});

describe("filterClaudeEnvVars", () => {
  let filterClaudeEnvVars: typeof import("#src/json-session.js").filterClaudeEnvVars;

  beforeEach(async () => {
    const mod = await import("#src/json-session.js");
    filterClaudeEnvVars = mod.filterClaudeEnvVars;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes CLAUDECODE_* variables from env object", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDECODE_SECRET: "abc",
      CLAUDECODE_TOKEN: "xyz",
      CLAUDE_BIN: "claude",
    } as NodeJS.ProcessEnv;

    const filtered = filterClaudeEnvVars(env);
    expect(filtered.CLAUDECODE_SECRET).toBeUndefined();
    expect(filtered.CLAUDECODE_TOKEN).toBeUndefined();
    expect(filtered.PATH).toBe("/usr/bin");
    expect(filtered.HOME).toBe("/home/user");
    expect(filtered.CLAUDE_BIN).toBe("claude");
  });
});

describe("buildClaudeArgs", () => {
  let buildClaudeArgs: typeof import("#src/json-session.js").buildClaudeArgs;

  beforeEach(async () => {
    const mod = await import("#src/json-session.js");
    buildClaudeArgs = mod.buildClaudeArgs;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes --fork-session in the args array by default", () => {
    const args = buildClaudeArgs({});
    expect(args).toContain("--fork-session");
  });

  it("includes --resume <id> --fork-session when resumeSessionId is provided", () => {
    const args = buildClaudeArgs({ resumeSessionId: "sess-abc-123" });
    expect(args).toContain("--resume");
    expect(args).toContain("sess-abc-123");
    expect(args).toContain("--fork-session");
    // --resume 出现在 --fork-session 之前
    const resumeIdx = args.indexOf("--resume");
    const forkIdx = args.indexOf("--fork-session");
    expect(resumeIdx).toBeLessThan(forkIdx);
  });

  it("includes --permission-prompt-tool stdio in args", () => {
    const args = buildClaudeArgs({});
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
  });

  it("includes --output-format and --input-format when specified", () => {
    const args = buildClaudeArgs({
      outputFormat: "stream-json",
      inputFormat: "stream-json",
    });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--input-format");
  });
});

describe("JsonSession claudeSessionId capture", () => {
  let JsonSession: typeof import("#src/json-session.js").JsonSession;

  beforeEach(async () => {
    mockChild = createMockChild();
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
    const mod = await import("#src/json-session.js");
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
