import { beforeEach, describe, expect, it, vi } from "vitest";
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
  maxTicks = 50,
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

describe("CodexAppServerSession", () => {
  let CodexAppServerSession: typeof import("#src/worker/codex-app-server-session.js").CodexAppServerSession;

  beforeEach(async () => {
    mockChild = createChildProcessFake();
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
    const mod = await import("#src/worker/codex-app-server-session.js");
    CodexAppServerSession = mod.CodexAppServerSession;
  });

  it("starts Codex app-server over stdio and sends initialize", async () => {
    const { spawn } = await import("node:child_process");
    const session = new CodexAppServerSession({ cwd: "/tmp/project" });

    expect(session.start()).toBe(12345);

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    expect(spawnCall[0]).toMatch(/codex$/);
    expect(spawnCall[1]).toEqual(["app-server", "--listen", "stdio://"]);
    expect(spawnCall[2]).toEqual(
      expect.objectContaining({
        cwd: "/tmp/project",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(readStdinLines()[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: {
          name: "dev-anywhere",
        },
      },
    });
  });

  it("rejects readiness when initialize never responds", async () => {
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      requestTimeoutMs: 5,
    });
    session.start();
    readStdinLines();

    await expect(session.waitUntilReady()).rejects.toThrow(/initialize.*timed out/i);
  });

  it("rejects readiness and pending requests when app-server exits before thread is ready", async () => {
    const session = new CodexAppServerSession({ cwd: "/tmp/project" });
    session.start();
    readStdinLines();
    const ready = session.waitUntilReady();

    mockChild.emit("exit", 1);

    await expect(ready).rejects.toThrow(/exited before ready/i);
  });

  it("rejects readiness when app-server spawn emits an error", async () => {
    const exitCodes: number[] = [];
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      onExit: (code) => exitCodes.push(code),
    });
    session.start();
    readStdinLines();

    mockChild.emit("error", new Error("spawn ENOENT"));

    await expect(session.waitUntilReady()).rejects.toThrow(/failed to start.*spawn ENOENT/i);
    expect(exitCodes).toEqual([1]);
    expect(session.getStderr()).toContain("spawn ENOENT");
  });

  it("rejects readiness when thread start does not return a thread id", async () => {
    const session = new CodexAppServerSession({ cwd: "/tmp/project" });
    session.start();
    readStdinLines();

    writeStdout({
      id: 1,
      result: {
        userAgent: "codex",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    const threadStart = (await waitForStdinLines())[0];
    writeStdout({
      id: threadStart.id,
      result: { thread: {} },
    });

    await expect(session.waitUntilReady()).rejects.toThrow(/thread id/i);
  });

  it("starts a thread after initialize and maps permission mode", async () => {
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      permissionMode: "bypassPermissions",
    });
    session.start();
    readStdinLines();

    writeStdout({
      id: 1,
      result: {
        userAgent: "codex",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });

    expect((await waitForStdinLines())[0]).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/tmp/project",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
  });

  it("queues user input until the thread is ready, then starts a turn", async () => {
    const session = new CodexAppServerSession({ cwd: "/tmp/project" });
    session.start();
    readStdinLines();
    session.sendMessage("Hello Codex");

    writeStdout({
      id: 1,
      result: {
        userAgent: "codex",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    const threadStart = (await waitForStdinLines())[0];
    writeStdout({
      id: threadStart.id,
      result: {
        thread: { id: "thread-1" },
      },
    });

    expect((await waitForStdinLines())[0]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Hello Codex", text_elements: [] }],
      },
    });
  });

  it("emits app-server notifications as Codex events", async () => {
    const events: Array<Record<string, unknown>> = [];
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    session.start();

    writeStdout({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "OK" },
    });
    await waitForCondition(() => events.length === 1, "codex notification timed out");

    expect(events).toEqual([
      {
        type: "codex_app_server",
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "OK" },
      },
    ]);
  });

  it("responds to item approval requests with Codex item decisions", async () => {
    const approvalStrategy = vi.fn(async () => ({ behavior: "allow" as const }));
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      approvalStrategy,
    });
    session.start();
    readStdinLines();

    writeStdout({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "pnpm test", cwd: "/tmp/project" },
    });
    await waitForCondition(
      () => approvalStrategy.mock.calls.length === 1 && mockChild.mockStdin.readableLength > 0,
      "approval response timed out",
    );

    expect(approvalStrategy).toHaveBeenCalledWith("Bash", {
      command: "pnpm test",
      cwd: "/tmp/project",
    });
    expect(readStdinLines()[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "approval-1",
      result: { decision: "accept" },
    });
  });

  it("responds to legacy Codex exec approval requests with review decisions", async () => {
    const approvalStrategy = vi.fn(async () => ({ behavior: "deny" as const }));
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      approvalStrategy,
    });
    session.start();
    readStdinLines();

    writeStdout({
      id: "legacy-approval-1",
      method: "execCommandApproval",
      params: { command: ["pnpm", "test"], cwd: "/tmp/project" },
    });
    await waitForCondition(
      () => approvalStrategy.mock.calls.length === 1 && mockChild.mockStdin.readableLength > 0,
      "legacy approval response timed out",
    );

    expect(approvalStrategy).toHaveBeenCalledWith("Bash", {
      command: "pnpm test",
      cwd: "/tmp/project",
    });
    expect(readStdinLines()[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "legacy-approval-1",
      result: { decision: "denied" },
    });
  });

  it("responds to Codex permission profile approval requests with granted permissions", async () => {
    const approvalStrategy = vi.fn(async () => ({ behavior: "allow" as const }));
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      approvalStrategy,
    });
    session.start();
    readStdinLines();

    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ["/tmp/project"], write: ["/tmp/project"] },
    };
    writeStdout({
      id: "permission-approval-1",
      method: "item/permissions/requestApproval",
      params: { reason: "Need project access", permissions },
    });
    await waitForCondition(
      () => approvalStrategy.mock.calls.length === 1 && mockChild.mockStdin.readableLength > 0,
      "permission approval response timed out",
    );

    expect(approvalStrategy).toHaveBeenCalledWith("Permissions", {
      reason: "Need project access",
      permissions,
    });
    expect(readStdinLines()[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "permission-approval-1",
      result: { permissions, scope: "turn" },
    });
  });

  it("denies Codex permission profile approval requests with an empty grant", async () => {
    const approvalStrategy = vi.fn(async () => ({ behavior: "deny" as const }));
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      approvalStrategy,
    });
    session.start();
    readStdinLines();

    writeStdout({
      id: "permission-approval-2",
      method: "item/permissions/requestApproval",
      params: {
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ["/tmp/project"], write: ["/tmp/project"] },
        },
      },
    });
    const response = (await waitForStdinLines("permission denial response timed out"))[0];

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "permission-approval-2",
      result: { permissions: {}, scope: "turn", strictAutoReview: true },
    });
  });
});
