import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CursorAcpExtensionDecision,
  CursorAcpPermissionDecision,
  CursorAcpSessionOptions,
} from "#src/worker/cursor-acp-session.js";
import { PROXY_VERSION } from "#src/version.js";
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

describe("CursorAcpSession", () => {
  let CursorAcpSession: typeof import("#src/worker/cursor-acp-session.js").CursorAcpSession;

  async function makeReady(options: CursorAcpSessionOptions = {}, sessionId = "cursor-session-1") {
    const session = new CursorAcpSession(options);
    session.start();

    const initialize = readStdinLines()[0];
    expect(initialize).toMatchObject({ method: "initialize" });
    writeStdout({
      id: initialize.id,
      result: { protocolVersion: 1, authMethods: [{ id: "cursor_login" }] },
    });

    const authenticate = (await waitForStdinLines())[0];
    expect(authenticate).toMatchObject({
      method: "authenticate",
      params: { methodId: "cursor_login" },
    });
    writeStdout({ id: authenticate.id, result: {} });

    const openSession = (await waitForStdinLines())[0];
    if (options.resumeSessionId) {
      expect(openSession).toMatchObject({ method: "session/load" });
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
    vi.stubEnv("CURSOR_BIN", "agent");
    mockChild = createChildProcessFake();
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
    ({ CursorAcpSession } = await import("#src/worker/cursor-acp-session.js"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("spawns agent acp and authenticates with cursor_login", async () => {
    const { spawn } = await import("node:child_process");
    const session = new CursorAcpSession({ cwd: "/tmp/project" });

    expect(session.start()).toBe(12345);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "agent",
      ["acp"],
      expect.objectContaining({
        cwd: "/tmp/project",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(readStdinLines()[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "dev-anywhere", title: "Dev Anywhere", version: PROXY_VERSION },
      },
    });
  });

  it.each([
    [undefined, "agent"],
    ["default", "agent"],
    ["auto", "agent"],
    ["plan", "plan"],
    ["bypassPermissions", "agent"],
  ])("maps permission mode %s to ACP mode %s", async (permissionMode, expectedMode) => {
    const session = new CursorAcpSession({ cwd: "/tmp/project", permissionMode });
    session.start();
    const initialize = readStdinLines()[0];
    writeStdout({
      id: initialize.id,
      result: { protocolVersion: 1, authMethods: [{ id: "cursor_login" }] },
    });
    const authenticate = (await waitForStdinLines())[0];
    writeStdout({ id: authenticate.id, result: {} });
    const create = (await waitForStdinLines())[0];
    writeStdout({ id: create.id, result: { sessionId: "mode-session" } });
    const setMode = (await waitForStdinLines())[0];
    expect(setMode).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "mode-session", modeId: expectedMode },
    });
    writeStdout({ id: setMode.id, result: {} });
    await expect(session.waitUntilReady()).resolves.toBe("mode-session");
  });

  it("falls back to session/new when session/load fails", async () => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new CursorAcpSession({
      cwd: "/tmp/project",
      resumeSessionId: "missing-session",
      onNotification: (method, params) => notifications.push({ method, params }),
    });
    session.start();
    const initialize = readStdinLines()[0];
    writeStdout({
      id: initialize.id,
      result: { protocolVersion: 1, authMethods: [{ id: "cursor_login" }] },
    });
    const authenticate = (await waitForStdinLines())[0];
    writeStdout({ id: authenticate.id, result: {} });
    const load = (await waitForStdinLines())[0];
    expect(load).toMatchObject({ method: "session/load" });
    writeStdout({
      id: load.id,
      error: { code: -32602, message: 'Session "missing-session" not found' },
    });
    const created = (await waitForStdinLines())[0];
    expect(created).toMatchObject({ method: "session/new" });
    writeStdout({ id: created.id, result: { sessionId: "fresh-session" } });
    const setMode = (await waitForStdinLines())[0];
    writeStdout({ id: setMode.id, result: {} });
    await expect(session.waitUntilReady()).resolves.toBe("fresh-session");
    expect(notifications[0]).toMatchObject({
      method: "cursor/session_load_failed",
      params: { requestedSessionId: "missing-session", sessionId: "fresh-session" },
    });
  });

  it("auto-approves tool permissions in auto mode but still forwards questions", async () => {
    const extensions: string[] = [];
    const session = await makeReady({
      permissionMode: "auto",
      onExtensionRequest: (request) => {
        extensions.push(request.prompt.type);
        return {
          answer: {
            type: "ask_question",
            outcome: "answered",
            answers: [{ questionId: "q1", selectedOptionIds: ["agent"] }],
          },
        };
      },
    });
    writeStdout({
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "cursor-session-1",
        options: [
          { optionId: "allow-always", name: "Always", kind: "allow-always" },
          { optionId: "reject-once", name: "Reject", kind: "reject-once" },
        ],
        toolCall: { title: "Bash" },
      },
    });
    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "allow-always" } },
    });

    writeStdout({
      id: "question-1",
      method: "cursor/ask_question",
      params: {
        toolCallId: "call-1",
        questions: [
          {
            id: "q1",
            prompt: "Which mode?",
            options: [
              { id: "agent", label: "Agent" },
              { id: "plan", label: "Plan" },
            ],
          },
        ],
      },
    });
    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "question-1",
      result: {
        outcome: {
          outcome: "answered",
          answers: [{ questionId: "q1", selectedOptionIds: ["agent"] }],
        },
      },
    });
    expect(extensions).toEqual(["ask_question"]);
    expect(session.getCursorSessionId()).toBe("cursor-session-1");
  });

  it("answers create_plan and cancels it when the turn is interrupted", async () => {
    let resolveDecision: ((decision: CursorAcpExtensionDecision) => void) | undefined;
    const session = await makeReady({
      onExtensionRequest: () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    });
    session.sendMessage("plan this");
    const prompt = (await waitForStdinLines())[0];
    expect(prompt).toMatchObject({ method: "session/prompt" });
    writeStdout({
      id: "plan-1",
      method: "cursor/create_plan",
      params: {
        name: "Refactor",
        plan: "1. Inspect\n2. Change",
        todos: [{ id: "t1", content: "Inspect", status: "pending" }],
      },
    });
    await waitForCondition(() => Boolean(resolveDecision), "create_plan callback timed out");
    await expect(session.interruptCurrentTurn()).resolves.toBe(true);
    const lines = readStdinLines();
    expect(lines).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "cursor-session-1" },
    });
    expect(lines).toContainEqual({
      jsonrpc: "2.0",
      id: "plan-1",
      result: { outcome: { outcome: "cancelled" } },
    });
    resolveDecision?.({
      answer: { type: "create_plan", outcome: "accepted" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(readStdinLines()).toEqual([]);
  });

  it("maps hyphenated permission kinds to selected option ids", async () => {
    await makeReady({
      onPermissionRequest: (): CursorAcpPermissionDecision => ({ behavior: "allow_once" }),
    });
    writeStdout({
      id: "permission-hyphen",
      method: "session/request_permission",
      params: {
        sessionId: "cursor-session-1",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow-once" },
          { optionId: "reject-once", name: "Reject", kind: "reject-once" },
        ],
        toolCall: { title: "Edit" },
      },
    });
    expect((await waitForStdinLines())[0]).toEqual({
      jsonrpc: "2.0",
      id: "permission-hyphen",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
  });
});
