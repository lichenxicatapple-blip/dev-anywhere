import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { StreamJsonEvent, ApprovalStrategy } from "../json-session.js";

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

// spawn 返回值需要在模块加载前 mock
let mockChild: ReturnType<typeof createMockChild>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

describe("JsonSession", () => {
  let JsonSession: typeof import("../json-session.js").JsonSession;

  beforeEach(async () => {
    mockChild = createMockChild();
    const mod = await import("../json-session.js");
    JsonSession = mod.JsonSession;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("start", () => {
    it("spawns claude with correct stream-json flags", async () => {
      const { spawn } = await import("node:child_process");
      const session = new JsonSession();
      session.start();

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          "--output-format", "stream-json",
          "--input-format", "stream-json",
          "--permission-prompt-tool", "stdio",
          "--verbose",
        ]),
        expect.objectContaining({
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
    });

    it("filters CLAUDECODE env variables from child process", async () => {
      const { spawn } = await import("node:child_process");
      const originalEnv = process.env;
      process.env = { ...originalEnv, CLAUDECODE_SECRET: "abc", PATH: "/usr/bin", HOME: "/home/user" };

      const session = new JsonSession();
      session.start();

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const env = spawnCall[2]?.env as Record<string, string>;
      expect(env.CLAUDECODE_SECRET).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin");

      process.env = originalEnv;
    });

    it("returns the child process PID", () => {
      const session = new JsonSession();
      const pid = session.start();
      expect(pid).toBe(12345);
    });

    it("appends extra claudeArgs to spawn arguments", async () => {
      const { spawn } = await import("node:child_process");
      const session = new JsonSession({ claudeArgs: ["--model", "opus"] });
      session.start();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).toContain("--model");
      expect(args).toContain("opus");
    });
  });

  describe("event parsing", () => {
    it("parses system init event and emits via onEvent", async () => {
      const events: StreamJsonEvent[] = [];
      const session = new JsonSession({
        onEvent: (e) => events.push(e),
      });
      session.start();

      const systemEvent = {
        type: "system",
        subtype: "init",
        session_id: "sess-123",
        tools: [],
        model: "claude-4",
      };
      mockChild.mockStdout.write(JSON.stringify(systemEvent) + "\n");

      await new Promise((r) => setTimeout(r, 50));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("system");
    });

    it("parses assistant event and emits via onEvent", async () => {
      const events: StreamJsonEvent[] = [];
      const session = new JsonSession({
        onEvent: (e) => events.push(e),
      });
      session.start();

      const assistantEvent = {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      };
      mockChild.mockStdout.write(JSON.stringify(assistantEvent) + "\n");

      await new Promise((r) => setTimeout(r, 50));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("assistant");
    });

    it("parses result event and emits via onEvent", async () => {
      const events: StreamJsonEvent[] = [];
      const session = new JsonSession({
        onEvent: (e) => events.push(e),
      });
      session.start();

      const resultEvent = {
        type: "result",
        result: "done",
        session_id: "sess-123",
      };
      mockChild.mockStdout.write(JSON.stringify(resultEvent) + "\n");

      await new Promise((r) => setTimeout(r, 50));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("result");
    });

    it("silently skips non-JSON lines", async () => {
      const events: StreamJsonEvent[] = [];
      const session = new JsonSession({
        onEvent: (e) => events.push(e),
      });
      session.start();

      mockChild.mockStdout.write("verbose debug output here\n");
      mockChild.mockStdout.write(JSON.stringify({ type: "result", result: "ok", session_id: "s1" }) + "\n");

      await new Promise((r) => setTimeout(r, 50));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("result");
    });
  });

  describe("tool approval", () => {
    it("sends deny response by default for control_request", async () => {
      const events: StreamJsonEvent[] = [];
      const session = new JsonSession({
        onEvent: (e) => events.push(e),
      });
      session.start();

      const controlRequest = {
        type: "control_request",
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          input: { file_path: "/tmp/test" },
        },
      };
      mockChild.mockStdout.write(JSON.stringify(controlRequest) + "\n");

      await new Promise((r) => setTimeout(r, 100));

      // 读取写入到 stdin 的数据
      const written = mockChild.mockStdin.read();
      expect(written).not.toBeNull();
      const response = JSON.parse(written.toString().trim());
      expect(response.type).toBe("control_response");
      expect(response.response.response.behavior).toBe("deny");
      expect(response.response.request_id).toBe("req-1");
    });

    it("uses injectable approval strategy that allows", async () => {
      const allowAll: ApprovalStrategy = async () => ({
        behavior: "allow" as const,
      });
      const session = new JsonSession({
        approvalStrategy: allowAll,
      });
      session.start();

      const controlRequest = {
        type: "control_request",
        request_id: "req-2",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls" },
        },
      };
      mockChild.mockStdout.write(JSON.stringify(controlRequest) + "\n");

      await new Promise((r) => setTimeout(r, 100));

      const written = mockChild.mockStdin.read();
      const response = JSON.parse(written.toString().trim());
      expect(response.type).toBe("control_response");
      expect(response.response.response.behavior).toBe("allow");
      expect(response.response.response.updatedInput).toEqual({});
    });

    it("does not emit control_request via onEvent", async () => {
      const events: StreamJsonEvent[] = [];
      const session = new JsonSession({
        onEvent: (e) => events.push(e),
      });
      session.start();

      const controlRequest = {
        type: "control_request",
        request_id: "req-3",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          input: {},
        },
      };
      mockChild.mockStdout.write(JSON.stringify(controlRequest) + "\n");

      await new Promise((r) => setTimeout(r, 100));
      // control_request 由内部处理，不应传递到 onEvent
      expect(events.filter((e) => e.type === "control_request")).toHaveLength(0);
    });
  });

  describe("sendMessage", () => {
    it("writes user message in correct format to stdin", async () => {
      const session = new JsonSession();
      session.start();
      session.sendMessage("Hello Claude");

      await new Promise((r) => setTimeout(r, 50));

      const written = mockChild.mockStdin.read();
      const parsed = JSON.parse(written.toString().trim());
      expect(parsed).toEqual({
        type: "user",
        message: { role: "user", content: "Hello Claude" },
      });
    });
  });

  describe("write queue serialization", () => {
    it("serializes concurrent writes without interleaving", async () => {
      const session = new JsonSession();
      session.start();

      // 发送多条消息，验证不会交错
      session.sendMessage("message-1");
      session.sendMessage("message-2");

      await new Promise((r) => setTimeout(r, 100));

      // 读取所有写入
      const allData = mockChild.mockStdin.read();
      const lines = allData.toString().split("\n").filter((l: string) => l.trim());
      expect(lines).toHaveLength(2);

      const msg1 = JSON.parse(lines[0]);
      const msg2 = JSON.parse(lines[1]);
      expect(msg1.message.content).toBe("message-1");
      expect(msg2.message.content).toBe("message-2");
    });
  });

  describe("stderr collection", () => {
    it("collects stderr output", async () => {
      const session = new JsonSession();
      session.start();

      mockChild.mockStderr.write("warning: something\n");
      mockChild.mockStderr.write("error: something else\n");

      await new Promise((r) => setTimeout(r, 50));
      expect(session.getStderr()).toBe("warning: something\nerror: something else\n");
    });
  });

  describe("exit handling", () => {
    it("calls onExit callback with exit code", async () => {
      const exitCodes: number[] = [];
      const session = new JsonSession({
        onExit: (code) => exitCodes.push(code),
      });
      session.start();

      mockChild.emit("exit", 0, null);

      await new Promise((r) => setTimeout(r, 50));
      expect(exitCodes).toEqual([0]);
    });

    it("defaults to exit code 1 when code is null", async () => {
      const exitCodes: number[] = [];
      const session = new JsonSession({
        onExit: (code) => exitCodes.push(code),
      });
      session.start();

      mockChild.emit("exit", null, null);

      await new Promise((r) => setTimeout(r, 50));
      expect(exitCodes).toEqual([1]);
    });
  });

  describe("stop", () => {
    it("sends SIGTERM to child process", async () => {
      const session = new JsonSession();
      session.start();

      // 模拟进程在 SIGTERM 后退出
      mockChild.kill = vi.fn().mockImplementation(() => {
        mockChild.emit("exit", 0, null);
        return true;
      });

      // 让 isAlive 在 stop 调用后返回 false
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });

      await session.stop(500);
      expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");

      killSpy.mockRestore();
    });
  });

  describe("isAlive", () => {
    it("returns true when process is running", () => {
      const session = new JsonSession();
      session.start();

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      expect(session.isAlive()).toBe(true);
      killSpy.mockRestore();
    });

    it("returns false when process is dead", () => {
      const session = new JsonSession();
      session.start();

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });
      expect(session.isAlive()).toBe(false);
      killSpy.mockRestore();
    });

    it("returns false when no child process exists", () => {
      const session = new JsonSession();
      expect(session.isAlive()).toBe(false);
    });
  });
});
