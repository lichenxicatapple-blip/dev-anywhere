import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StreamJsonEvent, ApprovalStrategy } from "#src/worker/json-session.js";
import { createChildProcessFake } from "./test-fakes.js";

// spawn 返回值需要在模块加载前 mock
let mockChild: ReturnType<typeof createChildProcessFake>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(message);
    },
    { timeout: timeoutMs },
  );
}

async function waitForEvents(events: unknown[], count: number): Promise<void> {
  await waitForCondition(
    () => events.length >= count,
    `timed out waiting for ${count} event(s); got ${events.length}`,
  );
}

async function readStdinWhenReady(child = mockChild): Promise<Buffer> {
  await waitForCondition(() => child.mockStdin.readableLength > 0, "stdin write timed out");
  const written = child.mockStdin.read();
  if (!written) throw new Error("stdin became readable but returned no data");
  return Buffer.isBuffer(written) ? written : Buffer.from(written);
}

describe("JsonSession", () => {
  let JsonSession: typeof import("#src/worker/json-session.js").JsonSession;
  let createPermissionModeApprovalStrategy: typeof import("#src/worker/json-session.js").createPermissionModeApprovalStrategy;

  beforeEach(async () => {
    mockChild = createChildProcessFake();
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
    const mod = await import("#src/worker/json-session.js");
    JsonSession = mod.JsonSession;
    createPermissionModeApprovalStrategy = mod.createPermissionModeApprovalStrategy;
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
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--permission-prompt-tool",
          "stdio",
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
      process.env = { ...originalEnv, CLAUDECODE_SECRET: "abc", CLAUDECODE_TOKEN: "xyz" };

      const session = new JsonSession();
      session.start();

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const env = spawnCall[2]?.env as Record<string, string>;
      expect(env.CLAUDECODE_SECRET).toBeUndefined();
      expect(env.CLAUDECODE_TOKEN).toBeUndefined();
      // 非 CLAUDECODE 开头的变量原样透传（取自父进程 PATH）
      expect(env.PATH).toBe(originalEnv.PATH);

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

    it("spawns Claude stream-json with the requested permission mode", async () => {
      const { spawn } = await import("node:child_process");
      const session = new JsonSession({ permissionMode: "acceptEdits" });
      session.start();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
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

      await waitForEvents(events, 1);
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

      await waitForEvents(events, 1);
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

      await waitForEvents(events, 1);
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
      mockChild.mockStdout.write(
        JSON.stringify({ type: "result", result: "ok", session_id: "s1" }) + "\n",
      );

      await waitForEvents(events, 1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("result");
    });
  });

  describe("tool approval", () => {
    it("auto-allows every control request in bypass mode", async () => {
      const fallback = vi.fn<ApprovalStrategy>();
      const strategy = createPermissionModeApprovalStrategy("bypassPermissions", fallback);

      await expect(strategy("Bash", { command: "touch x" })).resolves.toEqual({
        behavior: "allow",
        message: "Auto-approved by permission mode",
      });
      expect(fallback).not.toHaveBeenCalled();
    });

    it("auto-allows edit tools in acceptEdits mode and forwards non-edit tools", async () => {
      const fallback = vi.fn<ApprovalStrategy>(async () => ({
        behavior: "deny",
        message: "manual approval required",
      }));
      const strategy = createPermissionModeApprovalStrategy("acceptEdits", fallback);

      await expect(strategy("Write", { file_path: "/tmp/x" })).resolves.toEqual({
        behavior: "allow",
        message: "Auto-approved edit by permission mode",
      });
      await expect(strategy("Bash", { command: "rm -rf x" })).resolves.toEqual({
        behavior: "deny",
        message: "manual approval required",
      });
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledWith("Bash", { command: "rm -rf x" });
    });

    it("denies tool use in plan mode without opening remote approval", async () => {
      const fallback = vi.fn<ApprovalStrategy>();
      const strategy = createPermissionModeApprovalStrategy("plan", fallback);

      await expect(strategy("Write", { file_path: "/tmp/x" })).resolves.toEqual({
        behavior: "deny",
        message: "Tool use denied by plan mode.",
      });
      expect(fallback).not.toHaveBeenCalled();
    });

    it("forwards control requests in strict and auto modes", async () => {
      const fallback = vi.fn<ApprovalStrategy>(async () => ({ behavior: "allow" }));

      await createPermissionModeApprovalStrategy("default", fallback)("Read", {});
      await createPermissionModeApprovalStrategy("auto", fallback)("Bash", { command: "ls" });

      expect(fallback).toHaveBeenNthCalledWith(1, "Read", {});
      expect(fallback).toHaveBeenNthCalledWith(2, "Bash", { command: "ls" });
    });

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

      // 读取写入到 stdin 的数据
      const written = await readStdinWhenReady();
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

      const written = await readStdinWhenReady();
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

      await readStdinWhenReady();
      // control_request 由内部处理，不应传递到 onEvent
      expect(events.filter((e) => e.type === "control_request")).toHaveLength(0);
    });
  });

  describe("sendMessage", () => {
    it("writes user message in correct format to stdin", async () => {
      const session = new JsonSession();
      session.start();
      session.sendMessage("Hello Claude");

      const written = await readStdinWhenReady();
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

      await waitForCondition(
        () => mockChild.mockStdin.readableLength > 0,
        "queued stdin writes timed out",
      );

      // 读取所有写入
      const allData = mockChild.mockStdin.read();
      const lines = allData
        .toString()
        .split("\n")
        .filter((l: string) => l.trim());
      expect(lines).toHaveLength(2);

      const msg1 = JSON.parse(lines[0]);
      const msg2 = JSON.parse(lines[1]);
      expect(msg1.message.content).toBe("message-1");
      expect(msg2.message.content).toBe("message-2");
    });

    it("recovers from write failure so subsequent writes still go through", async () => {
      // 先抑制 console.error 噪音；失败路径会输出诊断
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const session = new JsonSession();
      // start 之前 child 为 null，writeToStdin 会 reject
      session.sendMessage("before-start");
      await waitForCondition(() => errSpy.mock.calls.length > 0, "write failure was not logged");

      // start 之后正常的 sendMessage 必须能走通；如果 writeQueue 永久 rejected，这条会静默失败
      session.start();
      session.sendMessage("after-start");

      const written = await readStdinWhenReady();
      const parsed = JSON.parse(written.toString().trim());
      expect(parsed.message.content).toBe("after-start");

      errSpy.mockRestore();
    });
  });

  describe("approval strategy failure", () => {
    it("falls back to deny response when approval strategy rejects", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const failingStrategy: ApprovalStrategy = async () => {
        throw new Error("approval channel broken");
      };
      const session = new JsonSession({ approvalStrategy: failingStrategy });
      session.start();

      const controlRequest = {
        type: "control_request",
        request_id: "req-fail",
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          input: { file_path: "/tmp/x" },
        },
      };
      mockChild.mockStdout.write(JSON.stringify(controlRequest) + "\n");

      // approval 失败时必须仍向 claude 写一个 deny 响应，否则 claude 永远等待 control_response
      const written = await readStdinWhenReady();
      const response = JSON.parse(written.toString().trim());
      expect(response.type).toBe("control_response");
      expect(response.response.request_id).toBe("req-fail");
      expect(response.response.response.behavior).toBe("deny");

      errSpy.mockRestore();
    });
  });

  describe("stderr collection", () => {
    it("collects stderr output", async () => {
      const session = new JsonSession();
      session.start();

      mockChild.mockStderr.write("warning: something\n");
      mockChild.mockStderr.write("error: something else\n");

      await waitForCondition(
        () => session.getStderr() === "warning: something\nerror: something else\n",
        "stderr collection timed out",
      );
      expect(session.getStderr()).toBe("warning: something\nerror: something else\n");
    });
  });

  describe("exit handling", () => {
    it("calls onExit callback with exit code after stdout end", async () => {
      const exitCodes: number[] = [];
      const session = new JsonSession({
        onExit: (code) => exitCodes.push(code),
      });
      session.start();

      // 真实 child 退出前/后 stdout pipe 自然 'end'。setupExitHandler 等 stdout 'end'
      // 后才 fire onExit, 否则 buffer 里最后几行 stream-json 会丢。
      mockChild.emit("exit", 0, null);
      mockChild.stdout!.emit("end");

      await waitForCondition(() => exitCodes.length === 1, "exit callback timed out");
      expect(exitCodes).toEqual([0]);
    });

    it("defaults to exit code 1 when code is null", async () => {
      const exitCodes: number[] = [];
      const session = new JsonSession({
        onExit: (code) => exitCodes.push(code),
      });
      session.start();

      mockChild.emit("exit", null, null);
      mockChild.stdout!.emit("end");

      await waitForCondition(() => exitCodes.length === 1, "exit callback timed out");
      expect(exitCodes).toEqual([1]);
    });

    it("reports child spawn errors through onExit", async () => {
      const exitCodes: number[] = [];
      const session = new JsonSession({
        onExit: (code) => exitCodes.push(code),
      });
      session.start();

      mockChild.emit("error", new Error("spawn ENOENT"));

      await waitForCondition(() => exitCodes.length === 1, "spawn error callback timed out");
      expect(exitCodes).toEqual([1]);
      expect(session.getStderr()).toContain("spawn ENOENT");
    });

    // 兜底: child 异常退出且 stdout 卡住, 'end' 永不到时, 1s 后强制 fire onExit 防 session 永挂。
    it("fires onExit after 1s fallback if stdout never ends", async () => {
      vi.useFakeTimers();
      try {
        const exitCodes: number[] = [];
        const session = new JsonSession({
          onExit: (code) => exitCodes.push(code),
        });
        session.start();
        mockChild.emit("exit", 0, null);
        // 不 emit stdout 'end'

        await vi.advanceTimersByTimeAsync(1100);
        expect(exitCodes).toEqual([0]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("stop", () => {
    it("sends SIGTERM to child process", async () => {
      const session = new JsonSession();
      session.start();

      // 第一次 isAlive 返回 true（stop 入口检查），之后返回 false（SIGTERM 后已退出）
      let aliveCallCount = 0;
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        aliveCallCount++;
        if (aliveCallCount <= 1) return true;
        throw new Error("ESRCH");
      });

      mockChild.kill = vi.fn().mockReturnValue(true);

      await session.stop(500);
      expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");

      killSpy.mockRestore();
    });

    it("interrupts the active turn without firing session exit and restarts Claude with resume", async () => {
      const { spawn } = await import("node:child_process");
      const exitCodes: number[] = [];
      const session = new JsonSession({
        onExit: (code) => exitCodes.push(code),
      });
      session.start();

      mockChild.mockStdout.write(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "claude-session-1",
        }) + "\n",
      );
      await waitForCondition(
        () => session.getClaudeSessionId() === "claude-session-1",
        "session id not captured",
      );

      const firstChild = mockChild;
      const secondChild = createChildProcessFake();
      let probeCount = 0;
      const killProbe = vi.spyOn(process, "kill").mockImplementation(() => {
        probeCount++;
        if (probeCount === 1) return true;
        throw new Error("ESRCH");
      });

      const interrupted = session.interruptCurrentTurn(500);
      expect(firstChild.kill).toHaveBeenCalledWith("SIGINT");

      mockChild = secondChild;
      firstChild.emit("exit", 130, "SIGINT");
      firstChild.stdout!.emit("end");

      await expect(interrupted).resolves.toBe(true);
      expect(exitCodes).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(vi.mocked(spawn).mock.calls[1][1]).toEqual(
        expect.arrayContaining(["--resume", "claude-session-1"]),
      );

      session.sendMessage("after interrupt");
      const written = await readStdinWhenReady(secondChild);
      expect(JSON.parse(written.toString().trim()).message.content).toBe("after interrupt");

      killProbe.mockRestore();
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
