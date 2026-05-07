import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayControlSchema, SessionState } from "@dev-anywhere/shared";
import { IpcMessageSchema } from "#src/ipc/ipc-protocol.js";
import { RelayRouter } from "#src/serve/relay-router.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";
import type { Socket } from "node:net";
import {
  createRelayConnectionFake,
  createWorkerRegistryFake,
  createWritableSocketFake,
} from "./test-fakes.js";

function parseIpc(raw: string) {
  return IpcMessageSchema.parse(JSON.parse(raw.trim()));
}

function createRouter(options: {
  mode: "json" | "pty";
  workerSend?: ReturnType<typeof vi.fn>;
  terminalWrite?: ReturnType<typeof vi.fn>;
  hostedWrite?: ReturnType<typeof vi.fn>;
  jsonTurnStart?: ReturnType<typeof vi.fn>;
  relaySend?: (data: string) => void;
  workerSpawn?: () => number;
  workerConnect?: () => Promise<Socket | null>;
  workerTerminateProcess?: (sessionId: string) => boolean;
  cleanupHookContext?: (sessionId: string) => void;
}): RelayRouter {
  const terminalSockets = new Map<string, Socket>();
  if (options.terminalWrite) {
    terminalSockets.set("s1", createWritableSocketFake(options.terminalWrite).socket);
  }

  return new RelayRouter({
    sessionManager: {
      getSession: (sessionId: string) =>
        sessionId === "s1"
          ? {
              id: "s1",
              mode: options.mode,
              provider: "claude",
              state: SessionState.IDLE,
              cwd: "/tmp",
              pid: 1,
            }
          : undefined,
    } as never,
    workerRegistry: createWorkerRegistryFake({
      send: options.workerSend,
      spawn: options.workerSpawn,
      connect: options.workerConnect ? vi.fn(options.workerConnect) : undefined,
      terminateProcess: options.workerTerminateProcess
        ? vi.fn(options.workerTerminateProcess)
        : undefined,
    }),
    controlHandlers: {} as never,
    relayConnection: createRelayConnectionFake().relayConnection,
    relaySend: options.relaySend ?? vi.fn(),
    terminalSockets,
    hostedPtyRegistry: {
      write: options.hostedWrite ?? vi.fn(() => false),
      snapshot: vi.fn(() => false),
      resize: vi.fn(() => false),
      terminate: vi.fn(() => false),
    } as never,
    broadcastSessionList: () => {},
    broadcastSessionSync: () => {},
    jsonObserver: {
      onTurnStart: options.jsonTurnStart ?? vi.fn(),
    } as never,
    createHookContext: () => ({
      provider: "claude",
      sessionId: "pending",
      hookUrl: "http://127.0.0.1:1/hook",
      marker: "marker",
      token: "token",
    }),
    cleanupHookContext: options.cleanupHookContext ?? vi.fn(),
    permissionBroker: new PermissionBroker(),
    hookEventRouter: {} as never,
    agentStatusRegistry: new AgentStatusRegistry(),
  });
}

describe("RelayRouter input routing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps JSON sessions on batch user_input", () => {
    const workerSend = vi.fn(() => true);
    const jsonTurnStart = vi.fn();
    const terminalWrite = vi.fn();
    const router = createRouter({
      mode: "json",
      workerSend,
      jsonTurnStart,
      terminalWrite,
    });

    router.handle({
      type: "user_input",
      sessionId: "s1",
      payload: { text: "hello" },
    });

    expect(jsonTurnStart).toHaveBeenCalledWith("s1");
    expect(workerSend).toHaveBeenCalledWith("s1", {
      type: "worker_input",
      content: "hello",
    });
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("rejects session_create immediately when cwd does not exist", () => {
    const relaySend = vi.fn();
    const workerSpawn = vi.fn();
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn,
    });

    router.handle({
      type: "session_create",
      cwd: "/Users/admin/path-that-should-not-exist-dev-anywhere-test",
      provider: "claude",
      mode: "json",
    });

    expect(workerSpawn).not.toHaveBeenCalled();
    expect(relaySend).toHaveBeenCalledTimes(1);
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg.type).toBe("session_create_response");
    if (msg.type === "session_create_response") {
      expect(msg.sessionId).toBe("");
      expect(msg.error).toContain("工作目录不存在或不可访问");
    }
  });

  it("cleans pending JSON worker when spawned worker never connects", async () => {
    vi.useFakeTimers();
    const relaySend = vi.fn();
    const workerTerminateProcess = vi.fn(() => true);
    const cleanupHookContext = vi.fn();
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn: vi.fn(() => 1234),
      workerConnect: vi.fn(async () => null),
      workerTerminateProcess,
      cleanupHookContext,
    });

    router.handle({
      type: "session_create",
      cwd: "/tmp",
      provider: "claude",
      mode: "json",
    });

    await vi.runAllTimersAsync();

    const lastRaw = relaySend.mock.calls.at(-1)?.[0];
    expect(lastRaw).toBeTruthy();
    const msg = RelayControlSchema.parse(JSON.parse(lastRaw!));
    expect(msg.type).toBe("session_create_response");
    if (msg.type === "session_create_response") {
      expect(msg.error).toBe("Worker failed to start");
    }
    expect(workerTerminateProcess).toHaveBeenCalledTimes(1);
    expect(cleanupHookContext).toHaveBeenCalledTimes(1);
  });

  it("drops batch user_input for PTY sessions", () => {
    const workerSend = vi.fn();
    const jsonTurnStart = vi.fn();
    const terminalWrite = vi.fn();
    const router = createRouter({
      mode: "pty",
      workerSend,
      jsonTurnStart,
      terminalWrite,
    });

    router.handle({
      type: "user_input",
      sessionId: "s1",
      payload: { text: "echo should-not-batch" },
    });

    expect(jsonTurnStart).not.toHaveBeenCalled();
    expect(workerSend).not.toHaveBeenCalled();
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("forwards remote_input_raw to PTY sessions without appending Enter", () => {
    const terminalWrite = vi.fn();
    const router = createRouter({ mode: "pty", terminalWrite });

    router.handle({
      type: "remote_input_raw",
      sessionId: "s1",
      data: "abc",
    });

    expect(terminalWrite).toHaveBeenCalledTimes(1);
    const ipc = parseIpc(terminalWrite.mock.calls[0][0] as string);
    expect(ipc.type).toBe("pty_input");
    if (ipc.type === "pty_input") {
      expect(ipc.sessionId).toBe("s1");
      expect(ipc.data).toBe("abc");
    }
  });

  it("forwards repeated Ctrl+C to PTY without debounce", () => {
    const terminalWrite = vi.fn();
    const router = createRouter({ mode: "pty", terminalWrite });

    router.handle({ type: "remote_input_raw", sessionId: "s1", data: "\x03" });
    router.handle({ type: "remote_input_raw", sessionId: "s1", data: "\x03" });

    expect(terminalWrite).toHaveBeenCalledTimes(2);
    for (const call of terminalWrite.mock.calls) {
      const ipc = parseIpc(call[0] as string);
      expect(ipc.type).toBe("pty_input");
      if (ipc.type === "pty_input") {
        expect(ipc.data).toBe("\x03");
      }
    }
  });

  it("forwards remote_input_raw to hosted PTY when no terminal socket is attached", () => {
    const hostedWrite = vi.fn(() => true);
    const router = createRouter({ mode: "pty", hostedWrite });

    router.handle({
      type: "remote_input_raw",
      sessionId: "s1",
      data: "abc",
    });

    expect(hostedWrite).toHaveBeenCalledWith("s1", "abc");
  });
});
