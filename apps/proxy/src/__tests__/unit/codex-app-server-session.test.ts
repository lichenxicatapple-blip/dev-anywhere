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
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(readStdinLines()[0]).toMatchObject({
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    const threadStart = readStdinLines()[0];
    writeStdout({
      id: threadStart.id,
      result: {
        thread: { id: "thread-1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(readStdinLines()[0]).toMatchObject({
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
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(readStdinLines()[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "permission-approval-2",
      result: { permissions: {}, scope: "turn", strictAutoReview: true },
    });
  });
});
