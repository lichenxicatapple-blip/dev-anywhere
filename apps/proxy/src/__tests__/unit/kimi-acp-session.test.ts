import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KimiAcpPermissionDecision,
  KimiAcpSessionOptions,
} from "#src/worker/kimi-acp-session.js";
import { createChildProcessFake } from "./test-fakes.js";

let mockChild: ReturnType<typeof createChildProcessFake>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

function readStdinLines(): Array<Record<string, unknown>> {
  const chunk = mockChild.mockStdin.read();
  if (!chunk) return [];
  return chunk
    .toString()
    .split("\n")
    .filter((line: string) => line.trim())
    .map((line: string) => JSON.parse(line));
}

function writeStdout(message: Record<string, unknown>): void {
  mockChild.mockStdout.write(`${JSON.stringify(message)}\n`);
}

async function waitForCondition(
  condition: () => boolean,
  message: string,
  maxTicks = 100,
): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

async function waitForStdinLines(message = "stdin write timed out") {
  await waitForCondition(() => mockChild.mockStdin.readableLength > 0, message);
  return readStdinLines();
}

describe("KimiAcpSession", () => {
  let KimiAcpSession: typeof import("#src/worker/kimi-acp-session.js").KimiAcpSession;

  async function makeReady(options: KimiAcpSessionOptions = {}, sessionId = "kimi-session-1") {
    const session = new KimiAcpSession(options);
    session.start();

    const initialize = readStdinLines()[0];
    expect(initialize).toMatchObject({ method: "initialize" });
    writeStdout({ id: initialize.id, result: { protocolVersion: 1 } });

    const openSession = (await waitForStdinLines())[0];
    if (options.resumeSessionId) {
      expect(openSession).toMatchObject({ method: "session/resume" });
      writeStdout({ id: openSession.id, result: {} });
    } else {
      expect(openSession).toMatchObject({ method: "session/new" });
      writeStdout({ id: openSession.id, result: { sessionId } });
    }

    const setMode = (await waitForStdinLines())[0];
    expect(setMode).toMatchObject({ method: "session/set_mode" });
    writeStdout({ id: setMode.id, result: {} });
    await expect(session.waitUntilReady()).resolves.toBe(options.resumeSessionId ?? sessionId);
    return session;
  }

  beforeEach(async () => {
    vi.stubEnv("KIMI_BIN", "kimi");
    mockChild = createChildProcessFake();
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
    ({ KimiAcpSession } = await import("#src/worker/kimi-acp-session.js"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("spawns kimi acp over stdio and initializes ACP protocol version 1", async () => {
    const { spawn } = await import("node:child_process");
    const session = new KimiAcpSession({ cwd: "/tmp/project" });

    expect(session.start()).toBe(12345);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "kimi",
      ["acp"],
      expect.objectContaining({
        cwd: "/tmp/project",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(readStdinLines()[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "dev-anywhere", title: "Dev Anywhere", version: "0.8.0" },
      },
    });
  });

  it.each([
    [undefined, "default"],
    ["default", "default"],
    ["auto", "yolo"],
    ["plan", "plan"],
    ["bypassPermissions", "auto"],
  ])("maps permission mode %s to ACP mode %s", async (permissionMode, expectedMode) => {
    const session = new KimiAcpSession({ cwd: "/tmp/project", permissionMode });
    session.start();
    const initialize = readStdinLines()[0];
    writeStdout({ id: initialize.id, result: { protocolVersion: 1 } });
    const create = (await waitForStdinLines())[0];
    expect(create).toMatchObject({
      method: "session/new",
      params: { cwd: "/tmp/project", mcpServers: [] },
    });
    writeStdout({ id: create.id, result: { sessionId: "mode-session" } });
    const setMode = (await waitForStdinLines())[0];
    expect(setMode).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "mode-session", modeId: expectedMode },
    });
    writeStdout({ id: setMode.id, result: {} });
    await expect(session.waitUntilReady()).resolves.toBe("mode-session");
  });

  it("resumes a native session without requesting an unbounded ACP history replay", async () => {
    const sessionIds: string[] = [];
    const session = new KimiAcpSession({
      cwd: "/tmp/project",
      resumeSessionId: "existing-kimi-session",
      onSessionId: (id) => sessionIds.push(id),
    });
    session.start();
    const initialize = readStdinLines()[0];
    writeStdout({ id: initialize.id, result: { protocolVersion: 1 } });

    const resume = (await waitForStdinLines())[0];
    expect(resume).toMatchObject({
      method: "session/resume",
      params: {
        sessionId: "existing-kimi-session",
        cwd: "/tmp/project",
        mcpServers: [],
      },
    });
    writeStdout({ id: resume.id, result: {} });
    const setMode = (await waitForStdinLines())[0];
    writeStdout({ id: setMode.id, result: {} });

    await expect(session.waitUntilReady()).resolves.toBe("existing-kimi-session");
    expect(session.getKimiSessionId()).toBe("existing-kimi-session");
    expect(sessionIds).toEqual(["existing-kimi-session"]);
  });

  it("queues a prompt until ready, forwards raw updates, and reports final stop reason", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const started = vi.fn();
    const completed = vi.fn();
    const session = new KimiAcpSession({
      cwd: "/tmp/project",
      onUpdate: (params) => updates.push(params),
      onNotification: (method, params) => notifications.push({ method, params }),
      onPromptStart: started,
      onPromptComplete: completed,
    });
    session.start();
    const initialize = readStdinLines()[0];
    session.sendMessage("Hello Kimi");
    expect(readStdinLines()).toEqual([]);

    writeStdout({ id: initialize.id, result: { protocolVersion: 1 } });
    const create = (await waitForStdinLines())[0];
    writeStdout({ id: create.id, result: { sessionId: "prompt-session" } });
    const setMode = (await waitForStdinLines())[0];
    writeStdout({ id: setMode.id, result: {} });
    const prompt = (await waitForStdinLines())[0];
    expect(prompt).toMatchObject({
      method: "session/prompt",
      params: {
        sessionId: "prompt-session",
        prompt: [{ type: "text", text: "Hello Kimi" }],
      },
    });
    expect(started).toHaveBeenCalledTimes(1);

    const update = {
      sessionId: "prompt-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
    };
    writeStdout({ method: "session/update", params: update });
    writeStdout({ id: prompt.id, result: { stopReason: "end_turn", providerData: 1 } });
    await waitForCondition(() => completed.mock.calls.length === 1, "prompt result timed out");

    expect(updates).toEqual([update]);
    expect(notifications).toEqual([{ method: "session/update", params: update }]);
    expect(completed).toHaveBeenCalledWith({ stopReason: "end_turn", providerData: 1 });
  });

  it("reports prompt JSON-RPC errors without breaking the session", async () => {
    const promptErrors: Error[] = [];
    const session = await makeReady({ onPromptError: (error) => promptErrors.push(error) });
    session.sendMessage("fail safely");
    const prompt = (await waitForStdinLines())[0];
    writeStdout({
      id: prompt.id,
      error: { code: -32000, message: "model unavailable", data: { retryable: true } },
    });

    await waitForCondition(() => promptErrors.length === 1, "prompt error timed out");
    expect(promptErrors[0]).toMatchObject({
      name: "KimiAcpRpcError",
      method: "session/prompt",
      code: -32000,
      data: { retryable: true },
    });
    expect(promptErrors[0]?.message).toContain("model unavailable");
  });

  it("preserves dynamic permission options, tool call details, and tracked raw input", async () => {
    let resolveDecision: ((decision: KimiAcpPermissionDecision) => void) | undefined;
    const requests: Array<import("#src/worker/kimi-acp-session.js").KimiAcpPermissionRequest> = [];
    const session = await makeReady({
      onPermissionRequest: (request) => {
        requests.push(request);
        return new Promise((resolve) => {
          resolveDecision = resolve;
        });
      },
    });
    writeStdout({
      method: "session/update",
      params: {
        sessionId: "kimi-session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Bash",
          rawInput: { command: ["pnpm", "test"], cwd: "/tmp/project" },
        },
      },
    });
    writeStdout({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "kimi-session-1",
        options: [
          { optionId: "once", name: "Approve once", kind: "allow_once" },
          { optionId: "always", name: "Approve for this session", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
        toolCall: {
          toolCallId: "tool-1",
          title: "Bash",
          content: [{ type: "content", content: { type: "text", text: "pnpm test" } }],
        },
      },
    });
    await waitForCondition(() => requests.length === 1, "permission callback timed out");

    expect(requests[0]).toMatchObject({
      requestId: "permission-1",
      sessionId: "kimi-session-1",
      toolName: "Bash",
      input: { command: "pnpm test", cwd: "/tmp/project" },
      rawToolCall: {
        toolCallId: "tool-1",
        title: "Bash",
        content: [{ type: "content", content: { type: "text", text: "pnpm test" } }],
      },
      toolCall: {
        toolCallId: "tool-1",
        title: "Bash",
        rawInput: { command: ["pnpm", "test"], cwd: "/tmp/project" },
      },
      options: [
        { optionId: "once", name: "Approve once", kind: "allow_once" },
        { optionId: "always", name: "Approve for this session", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(requests[0]?.rawParams.toolCall).toEqual(
      expect.objectContaining({ toolCallId: "tool-1" }),
    );
    expect(session.getPendingPermission("permission-1")).toBe(requests[0]);

    resolveDecision?.({ behavior: "allow_once" });
    const response = (await waitForStdinLines("permission response timed out"))[0];
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "once" } },
    });
    expect(session.getPendingPermission("permission-1")).toBeUndefined();
  });

  it("selects an exact AskUserQuestion option and rejects stale or contradictory decisions", async () => {
    const decisions: KimiAcpPermissionDecision[] = [
      { optionId: "answer-b", behavior: "allow_once" },
      { optionId: "stale-answer" },
      { optionId: "answer-a", behavior: "deny" },
    ];
    await makeReady({
      onPermissionRequest: () => decisions.shift() ?? { cancelled: true },
    });
    const options = [
      { optionId: "answer-a", name: "A", kind: "allow_once" },
      { optionId: "answer-b", name: "B", kind: "allow_once" },
      { optionId: "skip", name: "Skip", kind: "allow_once" },
    ];

    writeStdout({
      id: "question-1",
      method: "session/request_permission",
      params: { sessionId: "kimi-session-1", options, toolCall: { title: "AskUserQuestion" } },
    });
    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "question-1",
      result: { outcome: { outcome: "selected", optionId: "answer-b" } },
    });

    writeStdout({
      id: "question-2",
      method: "session/request_permission",
      params: { sessionId: "kimi-session-1", options, toolCall: { title: "AskUserQuestion" } },
    });
    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "question-2",
      result: { outcome: { outcome: "cancelled" } },
    });

    writeStdout({
      id: "question-3",
      method: "session/request_permission",
      params: { sessionId: "kimi-session-1", options, toolCall: { title: "AskUserQuestion" } },
    });
    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "question-3",
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  it.each([
    ["allow_always", "persist"],
    ["allow_always", "once"],
    ["deny", "no"],
  ] as const)("maps %s to the safest advertised dynamic option", async (behavior, expectedId) => {
    await makeReady({ onPermissionRequest: () => ({ behavior }) });
    const options =
      expectedId === "persist"
        ? [
            { optionId: "persist", name: "Approve for this session", kind: "custom" },
            { optionId: "no", name: "Reject", kind: "custom" },
          ]
        : expectedId === "once"
          ? [{ optionId: "once", name: "Approve once", kind: "allow_once" }]
          : [{ optionId: "no", name: "Decline", kind: "custom" }];
    writeStdout({
      id: "dynamic-permission",
      method: "session/request_permission",
      params: { sessionId: "kimi-session-1", options, toolCall: { title: "Tool" } },
    });

    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "dynamic-permission",
      result: { outcome: { outcome: "selected", optionId: expectedId } },
    });
  });

  it.each([{ cancelled: true }, { behavior: "cancel" as const }])(
    "returns ACP cancelled for an explicit cancellation decision",
    async (decision) => {
      await makeReady({ onPermissionRequest: () => decision });
      writeStdout({
        id: "cancelled-permission",
        method: "session/request_permission",
        params: {
          sessionId: "kimi-session-1",
          options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
          toolCall: { title: "Bash" },
        },
      });

      expect((await waitForStdinLines())[0]).toEqual({
        jsonrpc: "2.0",
        id: "cancelled-permission",
        result: { outcome: { outcome: "cancelled" } },
      });
    },
  );

  it("fails closed to the advertised reject option when approval handling errors", async () => {
    await makeReady({
      onPermissionRequest: () => {
        throw new Error("approval socket closed");
      },
    });
    writeStdout({
      id: "failed-approval",
      method: "session/request_permission",
      params: {
        sessionId: "kimi-session-1",
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
        toolCall: { title: "Bash" },
      },
    });

    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "failed-approval",
      result: { outcome: { outcome: "selected", optionId: "reject" } },
    });
  });

  it("cancels pending reverse permission RPCs and suppresses the cancelled prompt result", async () => {
    let resolveDecision: ((decision: KimiAcpPermissionDecision) => void) | undefined;
    const completed = vi.fn();
    const errors = vi.fn();
    const onPermissionRequest = vi.fn(
      () =>
        new Promise<KimiAcpPermissionDecision>((resolve) => {
          resolveDecision = resolve;
        }),
    );
    const session = await makeReady({
      onPermissionRequest,
      onPromptComplete: completed,
      onPromptError: errors,
    });
    session.sendMessage("wait for approval");
    const prompt = (await waitForStdinLines())[0];
    writeStdout({
      id: "permission-during-turn",
      method: "session/request_permission",
      params: {
        sessionId: "kimi-session-1",
        options: [
          { optionId: "once", name: "Approve once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
        toolCall: { toolCallId: "tool-2", title: "Bash" },
      },
    });
    await waitForCondition(
      () => session.getPendingPermission("permission-during-turn") !== undefined,
      "pending permission timed out",
    );

    await expect(session.interruptCurrentTurn()).resolves.toBe(true);
    const cancelLines = readStdinLines();
    expect(cancelLines).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "kimi-session-1" },
    });
    expect(cancelLines).toContainEqual({
      jsonrpc: "2.0",
      id: "permission-during-turn",
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(session.getPendingPermission("permission-during-turn")).toBeUndefined();

    await expect(session.interruptCurrentTurn()).resolves.toBe(false);
    expect(readStdinLines()).toEqual([]);

    writeStdout({
      id: "late-permission",
      method: "session/request_permission",
      params: {
        sessionId: "kimi-session-1",
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
        toolCall: { title: "Bash" },
      },
    });
    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "late-permission",
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);

    resolveDecision?.({ behavior: "deny" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(readStdinLines()).toEqual([]);
    writeStdout({ id: prompt.id, result: { stopReason: "cancelled" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    await expect(session.interruptCurrentTurn()).resolves.toBe(false);
  });

  it("terminates an untrusted ACP transport when cancellation is not acknowledged", async () => {
    const completed = vi.fn();
    const promptErrors = vi.fn();
    const permissionRequests = vi.fn(() => ({ behavior: "allow_once" as const }));
    const protocolErrors = vi.fn();
    const exited = vi.fn();
    const session = await makeReady({
      cancelAcknowledgeTimeoutMs: 5,
      onPromptComplete: completed,
      onPromptError: promptErrors,
      onPermissionRequest: permissionRequests,
      onProtocolError: protocolErrors,
      onExit: exited,
    });

    session.sendMessage("first");
    const firstPrompt = (await waitForStdinLines())[0];
    await expect(session.interruptCurrentTurn()).resolves.toBe(true);
    expect(readStdinLines()).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "kimi-session-1" },
    });

    session.sendMessage("second");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await waitForCondition(
      () => promptErrors.mock.calls.length === 1,
      "queued prompt did not fail closed",
    );

    expect(mockChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(readStdinLines()).toEqual([]);
    expect(promptErrors.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining("did not acknowledge session/cancel"),
    });
    expect(completed).not.toHaveBeenCalled();

    writeStdout({
      id: "late-permission-after-timeout",
      method: "session/request_permission",
      params: {
        sessionId: "kimi-session-1",
        options: [{ optionId: "once", name: "Approve once", kind: "allow_once" }],
        toolCall: { title: "Bash" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(permissionRequests).not.toHaveBeenCalled();
    expect(readStdinLines()).toEqual([]);

    writeStdout({ id: firstPrompt.id, result: { stopReason: "cancelled" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(protocolErrors).not.toHaveBeenCalled();

    mockChild.emit("exit", null);
    mockChild.emit("exit", null);
    expect(exited).toHaveBeenCalledTimes(1);
  });

  it("closes the ACP session exactly once", async () => {
    const session = await makeReady();
    const closing = session.close();
    const closeRequest = (await waitForStdinLines())[0];
    expect(closeRequest).toMatchObject({
      method: "session/close",
      params: { sessionId: "kimi-session-1" },
    });
    writeStdout({ id: closeRequest.id, result: {} });
    await closing;
    await session.close();
    expect(readStdinLines()).toEqual([]);
  });

  it("reports malformed protocol messages and rejects unknown reverse RPC methods", async () => {
    const protocolErrors: Error[] = [];
    await makeReady({ onProtocolError: (error) => protocolErrors.push(error) });

    mockChild.mockStdout.write("{not-json}\n");
    await waitForCondition(() => protocolErrors.length === 1, "protocol error timed out");
    expect(protocolErrors[0]?.message).toContain("Invalid Kimi ACP JSON");

    writeStdout({ id: "unknown-1", method: "client/unknown", params: {} });
    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "unknown-1",
      error: {
        code: -32601,
        message: "Unsupported Kimi ACP client request: client/unknown",
      },
    });
  });

  it("rejects readiness on timeout, process error, and early exit", async () => {
    const timedOut = new KimiAcpSession({ requestTimeoutMs: 5 });
    timedOut.start();
    readStdinLines();
    await expect(timedOut.waitUntilReady()).rejects.toThrow(/initialize.*timed out/i);

    mockChild = createChildProcessFake();
    const processErrors: Error[] = [];
    const failedSpawn = new KimiAcpSession({
      onProcessError: (error) => processErrors.push(error),
    });
    failedSpawn.start();
    readStdinLines();
    mockChild.emit("error", new Error("spawn ENOENT"));
    await expect(failedSpawn.waitUntilReady()).rejects.toThrow(/failed to start.*spawn ENOENT/i);
    expect(processErrors[0]?.message).toContain("spawn ENOENT");

    mockChild = createChildProcessFake();
    const exited = new KimiAcpSession();
    exited.start();
    readStdinLines();
    mockChild.emit("exit", 9);
    await expect(exited.waitUntilReady()).rejects.toThrow(/exited before ready.*9/i);
  });

  it("retains only a bounded stderr tail", () => {
    const session = new KimiAcpSession({ requestTimeoutMs: 0 });
    session.start();
    readStdinLines();
    mockChild.mockStderr.write(`prefix-${"x".repeat(9_000)}-tail`);

    expect(session.getStderr()).toHaveLength(8_192);
    expect(session.getStderr()).not.toContain("prefix-");
    expect(session.getStderr()).toContain("-tail");
  });
});
