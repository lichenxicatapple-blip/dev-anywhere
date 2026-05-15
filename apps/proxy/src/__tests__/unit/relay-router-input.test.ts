import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlErrorCode, RelayControlSchema, SessionState } from "@dev-anywhere/shared";
import { IpcMessageSchema } from "#src/ipc/ipc-protocol.js";
import { RelayRouter } from "#src/serve/relay-router.js";
import { RelayInputHandlers } from "#src/serve/relay-input-handlers.js";
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
  relayConnection?: ReturnType<typeof createRelayConnectionFake>;
  workerSpawn?: (sessionId: string, options?: unknown) => number;
  workerConnect?: () => Promise<Socket | null>;
  workerTerminateProcess?: (sessionId: string) => boolean;
  cleanupHookContext?: (sessionId: string) => void;
  hostedStart?: (options: unknown) => number;
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
    relayConnection: (options.relayConnection ?? createRelayConnectionFake()).relayConnection,
    relaySend: options.relaySend ?? vi.fn(),
    terminalSockets,
    hostedPtyRegistry: {
      start: options.hostedStart ?? vi.fn(() => 1234),
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
    getProviderEnv: () => ({}),
    getAgentCliSuggestions: () => ({}),
    setAgentCliPath: () => {},
  });
}

describe("RelayRouter input routing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("echoes accepted JSON user_input back through relay for other clients", () => {
    const workerSend = vi.fn(() => true);
    const relay = createRelayConnectionFake();
    const jsonObserver = { onTurnStart: vi.fn() };
    const handlers = new RelayInputHandlers({
      sessionManager: {
        getSession: (sessionId: string) =>
          sessionId === "s1"
            ? {
                id: "s1",
                mode: "json",
                provider: "claude",
                state: SessionState.IDLE,
                cwd: "/tmp",
                pid: 1,
              }
            : undefined,
      } as never,
      workerRegistry: createWorkerRegistryFake({ send: workerSend }),
      terminalSockets: new Map(),
      hostedPtyRegistry: {
        write: vi.fn(() => false),
      } as never,
      jsonObserver: jsonObserver as never,
      relayConnection: relay.relayConnection,
    });

    handlers.onUserInput({
      type: "user_input",
      sessionId: "s1",
      seq: 7,
      timestamp: 1234,
      source: "client",
      version: "1",
      payload: { text: "hello", messageId: "s1-user-client-1" },
    });

    expect(workerSend).toHaveBeenCalledWith("s1", {
      type: "worker_input",
      content: "hello",
    });
    expect(relay.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(relay.envelopes[0]).toMatchObject({
      type: "user_input",
      sessionId: "s1",
      seq: 7,
      timestamp: 1234,
      source: "proxy",
      payload: { text: "hello", messageId: "s1-user-client-1" },
    });
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
      seq: 1,
      timestamp: 1700000000000,
      source: "client",
      version: "1.0",
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
      cwd: "/home/dev/path-that-should-not-exist-dev-anywhere-test",
      provider: "claude",
      mode: "json",
    });

    expect(workerSpawn).not.toHaveBeenCalled();
    expect(relaySend).toHaveBeenCalledTimes(1);
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg.type).toBe("session_create_response");
    if (msg.type === "session_create_response") {
      expect(msg.sessionId).toBeUndefined();
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
    if (typeof lastRaw !== "string") throw new Error("expected last relay send to be a string");
    const msg = RelayControlSchema.parse(JSON.parse(lastRaw));
    expect(msg.type).toBe("session_create_response");
    if (msg.type === "session_create_response") {
      expect(msg.error).toBe("Worker failed to start");
    }
    expect(workerTerminateProcess).toHaveBeenCalledTimes(1);
    expect(cleanupHookContext).toHaveBeenCalledTimes(1);
  });

  it("passes permissionMode to JSON worker spawn during session_create", () => {
    const workerSpawn = vi.fn((_sessionId: string, _options?: unknown) => 1234);
    const router = createRouter({
      mode: "json",
      workerSpawn,
    });

    router.handle({
      type: "session_create",
      cwd: "/tmp",
      provider: "claude",
      mode: "json",
      permissionMode: "plan",
    });

    expect(workerSpawn).toHaveBeenCalledTimes(1);
    expect(workerSpawn.mock.calls[0][1]).toMatchObject({
      cwd: "/tmp",
      permissionMode: "plan",
    });
  });

  it("passes permissionMode to hosted PTY start during session_create", () => {
    const hostedStart = vi.fn((_options: unknown) => 1234);
    const router = createRouter({
      mode: "pty",
      hostedStart,
    });

    router.handle({
      type: "session_create",
      cwd: "/tmp",
      provider: "codex",
      mode: "pty",
      permissionMode: "bypassPermissions",
    });

    expect(hostedStart).toHaveBeenCalledTimes(1);
    expect(hostedStart.mock.calls[0][0]).toMatchObject({
      provider: "codex",
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
    });
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

  it("rejects clipboard image uploads for missing sessions", () => {
    const relay = createRelayConnectionFake();
    const router = createRouter({ mode: "json", relayConnection: relay });

    router.handle({
      type: "clipboard_image_upload",
      requestId: "clip-1",
      sessionId: "missing",
      mimeType: "image/png",
      dataBase64: "AQID",
    });

    expect(relay.raw).toHaveLength(1);
    const msg = RelayControlSchema.parse(JSON.parse(relay.raw[0]!));
    expect(msg.type).toBe("clipboard_image_upload_response");
    if (msg.type === "clipboard_image_upload_response") {
      expect(msg.requestId).toBe("clip-1");
      expect(msg.sessionId).toBe("missing");
      expect(msg.success).toBe(false);
      expect(msg.path).toBeUndefined();
      expect(msg.errorCode).toBe(ControlErrorCode.SESSION_NOT_FOUND);
    }
  });

  it("returns image preview data for session cwd images", () => {
    const cwd = mkdtempSync(join(tmpdir(), "image-preview-router-"));
    const relay = createRelayConnectionFake();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    writeFileSync(join(cwd, "shot.png"), png);
    const handlers = new RelayInputHandlers({
      sessionManager: {
        getSession: (sessionId: string) =>
          sessionId === "s1"
            ? {
                id: "s1",
                mode: "json",
                provider: "claude",
                state: SessionState.IDLE,
                cwd,
                pid: 1,
              }
            : undefined,
      } as never,
      workerRegistry: createWorkerRegistryFake(),
      terminalSockets: new Map(),
      hostedPtyRegistry: {
        write: vi.fn(() => false),
      } as never,
      jsonObserver: { onTurnStart: vi.fn() } as never,
      relayConnection: relay.relayConnection,
    });

    try {
      handlers.onImagePreviewRequest({
        type: "image_preview_request",
        requestId: "preview-1",
        sessionId: "s1",
        path: "shot.png",
      });

      expect(relay.raw).toHaveLength(1);
      const msg = RelayControlSchema.parse(JSON.parse(relay.raw[0]!));
      expect(msg.type).toBe("image_preview_response");
      if (msg.type === "image_preview_response") {
        expect(msg.requestId).toBe("preview-1");
        expect(msg.success).toBe(true);
        expect(msg.mimeType).toBe("image/png");
        expect(msg.dataBase64).toBe(png.toString("base64"));
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
