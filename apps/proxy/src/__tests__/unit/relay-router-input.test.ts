import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlErrorCode,
  RelayControlSchema,
  SESSION_CREATE_SERVER_DEADLINE_MS,
  SessionState,
} from "@dev-anywhere/shared";
import { IpcMessageSchema } from "#src/ipc/ipc-protocol.js";
import { RelayRouter } from "#src/serve/relay-router.js";
import { RelayInputHandlers } from "#src/serve/relay-input-handlers.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";
import type { RemoteFileUploadManager } from "#src/serve/remote-file-upload.js";
import type { DevicePreviewManager } from "#src/serve/device-preview/device-preview-manager.js";
import type { PreviewManager } from "#src/serve/preview/preview-manager.js";
import type { SessionManager } from "#src/serve/session-manager.js";
import type { VoiceSummaryRunner } from "#src/serve/voice-summary-handler.js";
import type { HookProviderId, ProviderHookContext } from "#src/providers/index.js";
import { sessionPaths, tildify } from "#src/common/paths.js";
import { TerminalSubscriptionBacklog } from "#src/serve/terminal-subscription-backlog.js";
import { WorkerStartupError } from "#src/serve/worker-registry.js";
import type { Socket } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import {
  createRelayConnectionFake,
  createWorkerRegistryFake,
  createWritableSocketFake,
} from "./test-fakes.js";

function parseIpc(raw: string) {
  return IpcMessageSchema.parse(JSON.parse(raw.trim()));
}

function createRemoteFileStreamManagerFake() {
  return { start: vi.fn(), cancel: vi.fn() } as never;
}

function createRemoteFileUploadManagerFake() {
  return {
    start: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
    handleBinary: vi.fn(),
  } as unknown as RemoteFileUploadManager;
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
  workerHas?: (sessionId: string) => boolean;
  workerHasProcess?: (sessionId: string) => boolean;
  workerWaitForReady?: (sessionId: string, timeoutMs?: number) => Promise<void>;
  workerTerminateProcess?: (sessionId: string) => boolean;
  workerTakePendingNativeSession?: (
    sessionId: string,
  ) => { provider: "claude" | "codex" | "kimi"; sessionId: string } | undefined;
  permissionBroker?: PermissionBroker;
  agentStatusRegistry?: AgentStatusRegistry;
  cleanupHookContext?: (sessionId: string) => void;
  createHookContext?: (sessionId: string, provider: HookProviderId) => ProviderHookContext;
  pushCommandList?: ReturnType<typeof vi.fn>;
  handleSessionResourcesRequest?: ReturnType<typeof vi.fn>;
  controlCleanup?: ReturnType<typeof vi.fn>;
  hostedStart?: (options: unknown) => number;
  hostedAbortStartup?: (sessionId: string) => boolean;
  terminalWorkerStart?: (options: unknown) => number;
  sessionManager?: SessionManager;
  broadcastSessionList?: () => void;
  voiceSummaryRunner?: VoiceSummaryRunner;
  remoteFileUploadManager?: ReturnType<typeof createRemoteFileUploadManagerFake>;
  findCodexActiveWriter?: (threadId: string) => { pid: number } | null;
  findClosestAncestorPid?: (processPid: number, candidatePids: readonly number[]) => number | null;
  previewManager?: PreviewManager;
  devicePreviewManager?: DevicePreviewManager;
}): RelayRouter {
  const terminalSockets = new Map<string, Socket>();
  if (options.terminalWrite) {
    terminalSockets.set("s1", createWritableSocketFake(options.terminalWrite).socket);
  }

  return new RelayRouter({
    sessionManager:
      options.sessionManager ??
      ({
        listSessions: () => [],
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
      } as unknown as SessionManager),
    workerRegistry: createWorkerRegistryFake({
      send: options.workerSend,
      spawn: options.workerSpawn,
      connect: options.workerConnect ? vi.fn(options.workerConnect) : undefined,
      has: options.workerHas ? vi.fn(options.workerHas) : undefined,
      hasProcess: options.workerHasProcess ? vi.fn(options.workerHasProcess) : undefined,
      waitForReady: options.workerWaitForReady ? vi.fn(options.workerWaitForReady) : undefined,
      terminateProcess: options.workerTerminateProcess
        ? vi.fn(options.workerTerminateProcess)
        : undefined,
      takePendingNativeSession: options.workerTakePendingNativeSession
        ? vi.fn(options.workerTakePendingNativeSession)
        : undefined,
    }),
    controlHandlers: {
      pushCommandList: options.pushCommandList ?? vi.fn(),
      pushFileTree: vi.fn(),
      handleSessionResourcesRequest: options.handleSessionResourcesRequest ?? vi.fn(),
      cleanup: options.controlCleanup ?? vi.fn(),
    } as never,
    relayConnection: (options.relayConnection ?? createRelayConnectionFake()).relayConnection,
    relaySend: options.relaySend ?? vi.fn(),
    terminalSockets,
    hostedPtyRegistry: {
      start: options.hostedStart ?? vi.fn(() => 1234),
      write: options.hostedWrite ?? vi.fn(() => false),
      snapshot: vi.fn(() => false),
      resize: vi.fn(() => false),
      terminate: vi.fn(() => false),
      abortStartup: options.hostedAbortStartup ?? vi.fn(() => false),
    } as never,
    terminalWorkerSpawner: {
      start: options.terminalWorkerStart ?? vi.fn(() => 5678),
    } as never,
    broadcastSessionList: options.broadcastSessionList ?? (() => {}),
    broadcastSessionSync: () => {},
    jsonObserver: {
      onTurnStart: options.jsonTurnStart ?? vi.fn(),
    } as never,
    createHookContext:
      options.createHookContext ??
      (() => ({
        provider: "claude" as const,
        sessionId: "pending",
        hookUrl: "http://127.0.0.1:1/hook",
        marker: "marker",
        token: "token",
      })),
    cleanupHookContext: options.cleanupHookContext ?? vi.fn(),
    permissionBroker: options.permissionBroker ?? new PermissionBroker(),
    hookEventRouter: {} as never,
    agentStatusRegistry: options.agentStatusRegistry ?? new AgentStatusRegistry(),
    getProviderEnv: () => ({}),
    getAgentCliSuggestions: () => ({}),
    setAgentCliPath: () => {},
    remoteFileStreamManager: createRemoteFileStreamManagerFake(),
    remoteFileUploadManager: options.remoteFileUploadManager ?? createRemoteFileUploadManagerFake(),
    terminalSubscriptionBacklog: new TerminalSubscriptionBacklog(),
    voiceSummaryRunner: options.voiceSummaryRunner,
    findCodexActiveWriter: options.findCodexActiveWriter,
    findClosestAncestorPid: options.findClosestAncestorPid,
    previewManager:
      options.previewManager ??
      ({
        inspectCapabilities: vi.fn(async () => ({
          cloudflared: { available: false, error: "cloudflared not found" },
          cpolar: { available: false, error: "cpolar not found" },
        })),
      } as unknown as PreviewManager),
    devicePreviewManager:
      options.devicePreviewManager ??
      ({
        inspectCapabilities: vi.fn(async () => ({
          ios: {
            supported: false,
            available: false,
            interactive: false,
            error: "iOS Simulator is unsupported on this platform",
          },
          android: {
            supported: true,
            available: false,
            interactive: false,
            error: "adb not found",
          },
        })),
      } as unknown as DevicePreviewManager),
  });
}

describe("RelayRouter input routing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("routes scoped Web preview capability requests to the preview manager", async () => {
    const relaySend = vi.fn();
    const inspectCapabilities = vi.fn(async () => ({
      cloudflared: { available: true, command: "/opt/homebrew/bin/cloudflared" },
      cpolar: { available: false, error: "cpolar not found" },
    }));
    const router = createRouter({
      mode: "json",
      relaySend,
      previewManager: { inspectCapabilities } as unknown as PreviewManager,
    });

    router.handle({
      type: "preview_capability_request",
      requestId: "web-capability-1",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
      refreshPath: false,
    });

    await vi.waitFor(() => expect(relaySend).toHaveBeenCalledOnce());
    expect(inspectCapabilities).toHaveBeenCalledWith(false);
    expect(JSON.parse(String(relaySend.mock.calls[0]?.[0]))).toEqual({
      type: "preview_capability_response",
      requestId: "web-capability-1",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
      success: true,
      capability: {
        cloudflared: { available: true, command: "/opt/homebrew/bin/cloudflared" },
        cpolar: { available: false, error: "cpolar not found" },
      },
    });
  });

  it("rejects a static Web preview create without an explicit entry path", () => {
    const create = vi.fn();
    const relaySend = vi.fn();
    const router = createRouter({
      mode: "json",
      relaySend,
      previewManager: { create } as unknown as PreviewManager,
    });

    router.handle({
      type: "preview_create_request",
      requestId: "web-create-without-entry",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
      operationId: "web-create-operation-without-entry",
      source: { kind: "static", path: "/tmp/site" },
      tunnelProvider: "cloudflare",
    });

    expect(create).not.toHaveBeenCalled();
    expect(relaySend).not.toHaveBeenCalled();
  });

  it("routes device preview management messages to the isolated manager", () => {
    const relaySend = vi.fn();
    const list = vi.fn(() => ({ epoch: "device-epoch", revision: 0, previews: [] }));
    const router = createRouter({
      mode: "json",
      relaySend,
      devicePreviewManager: { list } as unknown as DevicePreviewManager,
    });

    router.handle({
      type: "device_preview_list_request",
      requestId: "device-list-1",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
    });

    expect(list).toHaveBeenCalledOnce();
    expect(JSON.parse(String(relaySend.mock.calls[0]?.[0]))).toMatchObject({
      type: "device_preview_list_response",
      requestId: "device-list-1",
      epoch: "device-epoch",
      previews: [],
    });
  });

  it("routes web and device preview rename messages", async () => {
    const relaySend = vi.fn();
    const renameWebPreview = vi.fn(() => ({ previewId: "web-preview-1", name: "Docs demo" }));
    const renameDevicePreview = vi.fn(() => ({
      previewId: "device-preview-1",
      name: "QA phone",
    }));
    const router = createRouter({
      mode: "json",
      relaySend,
      previewManager: { rename: renameWebPreview } as unknown as PreviewManager,
      devicePreviewManager: { rename: renameDevicePreview } as unknown as DevicePreviewManager,
    });

    router.handle({
      type: "preview_rename_request",
      requestId: "rename-web-1",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
      operationId: "rename-web-operation-1",
      previewId: "web-preview-1",
      name: "Docs demo",
    });
    router.handle({
      type: "device_preview_rename_request",
      requestId: "rename-device-1",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
      operationId: "rename-device-operation-1",
      previewId: "device-preview-1",
      name: "QA phone",
    });

    await vi.waitFor(() => {
      expect(renameWebPreview).toHaveBeenCalledWith("web-preview-1", "Docs demo");
      expect(renameDevicePreview).toHaveBeenCalledWith("device-preview-1", "QA phone");
    });
    expect(relaySend.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toMatchObject([
      {
        type: "preview_rename_response",
        requestId: "rename-web-1",
        operationId: "rename-web-operation-1",
        success: true,
      },
      {
        type: "device_preview_rename_response",
        requestId: "rename-device-1",
        operationId: "rename-device-operation-1",
        success: true,
      },
    ]);
  });

  it("uses one operation journal across Web and Device Preview mutations", async () => {
    const relaySend = vi.fn();
    const renameWebPreview = vi.fn(() => ({ previewId: "web-preview-1", name: "Docs demo" }));
    const renameDevicePreview = vi.fn(() => ({
      previewId: "device-preview-1",
      name: "QA phone",
    }));
    const router = createRouter({
      mode: "json",
      relaySend,
      previewManager: { rename: renameWebPreview } as unknown as PreviewManager,
      devicePreviewManager: { rename: renameDevicePreview } as unknown as DevicePreviewManager,
    });

    router.handle({
      type: "preview_rename_request",
      requestId: "rename-web-shared",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
      operationId: "shared-operation",
      previewId: "web-preview-1",
      name: "Docs demo",
    });
    await vi.waitFor(() => expect(renameWebPreview).toHaveBeenCalledOnce());
    router.handle({
      type: "device_preview_rename_request",
      requestId: "rename-device-shared",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
      operationId: "shared-operation",
      previewId: "device-preview-1",
      name: "QA phone",
    });
    await vi.waitFor(() => expect(relaySend).toHaveBeenCalledTimes(2));

    expect(renameDevicePreview).not.toHaveBeenCalled();
    expect(JSON.parse(String(relaySend.mock.calls[1]?.[0]))).toMatchObject({
      type: "device_preview_rename_response",
      requestId: "rename-device-shared",
      operationId: "shared-operation",
      success: false,
      errorCode: ControlErrorCode.OPERATION_CONFLICT,
    });
  });

  it("routes Relay-owned device input revocation to the manager", () => {
    const revokeInput = vi.fn();
    const router = createRouter({
      mode: "json",
      devicePreviewManager: { revokeInput } as unknown as DevicePreviewManager,
    });

    router.handle({
      type: "device_preview_input_revoke",
      leaseId: "device-lease-1",
      reason: "control_taken_over",
    });

    expect(revokeInput).toHaveBeenCalledWith("device-lease-1");
  });

  it("routes scoped device preview capability requests through the manager", async () => {
    const relaySend = vi.fn();
    const inspectCapabilities = vi.fn(async () => ({
      ios: {
        supported: true,
        available: true,
        interactive: true,
        command: "/usr/bin/xcrun",
      },
      android: { supported: true, available: false, interactive: false, error: "missing" },
    }));
    const router = createRouter({
      mode: "json",
      relaySend,
      devicePreviewManager: { inspectCapabilities } as unknown as DevicePreviewManager,
    });

    router.handle({
      type: "device_preview_capability_request",
      requestId: "device-capability-1",
      scope: { proxyId: "proxy-1", bindingId: "binding-1" },
      refreshPath: true,
    });

    await vi.waitFor(() => expect(relaySend).toHaveBeenCalledOnce());
    expect(inspectCapabilities).toHaveBeenCalledWith(true);
    expect(JSON.parse(String(relaySend.mock.calls[0]?.[0]))).toMatchObject({
      type: "device_preview_capability_response",
      requestId: "device-capability-1",
      success: true,
      capability: {
        ios: { available: true },
        android: { available: false },
      },
    });
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
      remoteFileStreamManager: createRemoteFileStreamManagerFake(),
      remoteFileUploadManager: createRemoteFileUploadManagerFake(),
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

  it("does not echo native /compact as a visible JSON user message", () => {
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
      remoteFileStreamManager: createRemoteFileStreamManagerFake(),
      remoteFileUploadManager: createRemoteFileUploadManagerFake(),
    });

    handlers.onUserInput({
      type: "user_input",
      sessionId: "s1",
      seq: 7,
      timestamp: 1234,
      source: "client",
      version: "1",
      payload: { text: "/compact", messageId: "s1-user-client-1" },
    });

    expect(workerSend).toHaveBeenCalledWith("s1", {
      type: "worker_input",
      content: "/compact",
    });
    expect(jsonObserver.onTurnStart).toHaveBeenCalledWith("s1", { compacting: true });
    expect(relay.sendEnvelope).not.toHaveBeenCalled();
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

  it("interrupts JSON turns through worker IPC instead of killing the session worker", () => {
    const workerSend = vi.fn(() => true);
    const router = createRouter({
      mode: "json",
      workerSend,
    });
    const killSpy = vi.spyOn(process, "kill");

    router.handle({
      type: "session_worker_abort",
      sessionId: "s1",
    });

    expect(workerSend).toHaveBeenCalledWith("s1", { type: "worker_interrupt" });
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("marks JSON /compact user_input as compacting instead of ordinary working", () => {
    const workerSend = vi.fn(() => true);
    const jsonTurnStart = vi.fn();
    const router = createRouter({
      mode: "json",
      workerSend,
      jsonTurnStart,
    });

    router.handle({
      type: "user_input",
      sessionId: "s1",
      seq: 1,
      timestamp: 1700000000000,
      source: "client",
      version: "1.0",
      payload: { text: " /compact " },
    });

    expect(jsonTurnStart).toHaveBeenCalledWith("s1", { compacting: true });
    expect(workerSend).toHaveBeenCalledWith("s1", {
      type: "worker_input",
      content: " /compact ",
    });
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
    const controlCleanup = vi.fn();
    const permissionBroker = new PermissionBroker();
    const agentStatusRegistry = new AgentStatusRegistry();
    let pendingId = "";
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn: vi.fn((sessionId: string) => {
        pendingId = sessionId;
        mkdirSync(sessionPaths(sessionId).dir, { recursive: true });
        permissionBroker.registerWorkerRequest(
          {
            requestId: "pending-startup-approval",
            sessionId,
            provider: "claude",
            toolName: "Bash",
            input: {},
          },
          vi.fn(),
        );
        agentStatusRegistry.set(sessionId, {
          provider: "claude",
          phase: "thinking",
          seq: 1,
          updatedAt: 1,
        });
        return 1234;
      }),
      workerConnect: vi.fn(async () => null),
      workerTerminateProcess,
      cleanupHookContext,
      controlCleanup,
      permissionBroker,
      agentStatusRegistry,
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
      expect(msg.error).toBe("Agent 启动超时，请检查 Agent CLI 配置与开发机负载后重试");
    }
    expect(workerTerminateProcess).toHaveBeenCalledTimes(1);
    expect(cleanupHookContext).toHaveBeenCalledTimes(1);
    expect(controlCleanup).toHaveBeenCalledTimes(1);
    expect(permissionBroker.listSession(pendingId)).toEqual([]);
    expect(agentStatusRegistry.get(pendingId)).toBeNull();
    expect(existsSync(sessionPaths(pendingId).dir)).toBe(false);
  });

  it("returns an actionable response when JSON worker spawn fails synchronously", () => {
    const relaySend = vi.fn();
    const cleanupHookContext = vi.fn();
    const workerTerminateProcess = vi.fn(() => false);
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn: vi.fn(() => {
        throw new Error("spawn EMFILE");
      }),
      workerTerminateProcess,
      cleanupHookContext,
    });

    router.handle({
      type: "session_create",
      requestId: "create-json-spawn-failed",
      cwd: "/tmp",
      provider: "claude",
      mode: "json",
    });

    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-json-spawn-failed",
      errorCode: ControlErrorCode.WORKER_START_FAILED,
      error: "Agent 进程启动失败，请检查 Agent CLI 配置后重试",
    });
    expect(workerTerminateProcess).toHaveBeenCalledTimes(1);
    expect(cleanupHookContext).toHaveBeenCalledTimes(1);
  });

  it("fails immediately when a JSON worker exits before opening its socket", async () => {
    vi.useFakeTimers();
    const relaySend = vi.fn();
    const workerTerminateProcess = vi.fn(() => false);
    const router = createRouter({
      mode: "json",
      relaySend,
      workerConnect: async () => null,
      workerHasProcess: () => false,
      workerTerminateProcess,
    });

    router.handle({
      type: "session_create",
      requestId: "create-json-exited-before-connect",
      cwd: "/tmp",
      provider: "claude",
      mode: "json",
    });
    await vi.advanceTimersByTimeAsync(100);

    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-json-exited-before-connect",
      errorCode: ControlErrorCode.WORKER_START_FAILED,
      error: "Agent 进程启动失败，请检查 Agent CLI 配置后重试",
    });
    expect(workerTerminateProcess).toHaveBeenCalledTimes(1);
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
    router.destroy();
  });

  it("allows Codex JSON session_create with on-request approval", () => {
    const workerSpawn = vi.fn((_sessionId: string, _options?: unknown) => 1234);
    const router = createRouter({
      mode: "json",
      workerSpawn,
    });

    router.handle({
      type: "session_create",
      cwd: "/tmp",
      provider: "codex",
      mode: "json",
      permissionMode: "auto",
    });

    expect(workerSpawn).toHaveBeenCalledTimes(1);
    expect(workerSpawn.mock.calls[0][1]).toMatchObject({
      cwd: "/tmp",
      provider: "codex",
      permissionMode: "auto",
    });
    router.destroy();
  });

  it("rejects the removed Codex strict approval policy without spawning", () => {
    const relaySend = vi.fn();
    const workerSpawn = vi.fn();
    const router = createRouter({ mode: "json", relaySend, workerSpawn });

    router.handle({
      type: "session_create",
      requestId: "codex-strict",
      cwd: "/tmp",
      provider: "codex",
      mode: "json",
      permissionMode: "default",
    });

    expect(workerSpawn).not.toHaveBeenCalled();
    expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]))).toMatchObject({
      type: "session_create_response",
      requestId: "codex-strict",
      errorCode: ControlErrorCode.APPROVAL_POLICY_UNSUPPORTED,
      error: expect.stringContaining("严格审批"),
    });
  });

  it("reports the real PID when an external Codex process owns the native session", () => {
    const relaySend = vi.fn();
    const workerSpawn = vi.fn();
    const findCodexActiveWriter = vi.fn(() => ({ pid: 46559 }));
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn,
      findCodexActiveWriter,
    });

    router.handle({
      type: "session_create",
      requestId: "codex-active-writer",
      cwd: "/tmp",
      provider: "codex",
      mode: "json",
      permissionMode: "auto",
      resumeSessionId: "019fa141-cdaf-78a2-a6c1-9cca04fb9f9a",
    });

    expect(workerSpawn).not.toHaveBeenCalled();
    expect(findCodexActiveWriter).toHaveBeenCalledWith("019fa141-cdaf-78a2-a6c1-9cca04fb9f9a", {});
    expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]))).toMatchObject({
      type: "session_create_response",
      requestId: "codex-active-writer",
      errorCode: ControlErrorCode.SESSION_ALREADY_ACTIVE,
      activeWriterPid: 46559,
      error: expect.stringContaining("不会自动终止"),
    });
  });

  it("reuses an already managed Codex session without asking the user or spawning", () => {
    const relaySend = vi.fn();
    const workerSpawn = vi.fn();
    const findCodexActiveWriter = vi.fn(() => ({ pid: 46559 }));
    const managed = {
      id: "managed-codex-session",
      mode: "pty" as const,
      provider: "codex" as const,
      ptyOwner: "local-terminal" as const,
      state: SessionState.IDLE,
      cwd: "/tmp",
      pid: 1234,
      createdAt: 1,
      updatedAt: 1,
      historySessionId: "019fa141-cdaf-78a2-a6c1-9cca04fb9f9a",
    };
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn,
      findCodexActiveWriter,
      sessionManager: {
        listSessions: () => [managed],
      } as unknown as SessionManager,
    });
    router.handle({
      type: "session_create",
      requestId: "codex-managed",
      cwd: "/tmp",
      provider: "codex",
      mode: "json",
      permissionMode: "auto",
      resumeSessionId: managed.historySessionId,
    });

    expect(workerSpawn).not.toHaveBeenCalled();
    expect(findCodexActiveWriter).not.toHaveBeenCalled();
    expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]))).toMatchObject({
      type: "session_create_response",
      requestId: "codex-managed",
      sessionId: managed.id,
      mode: "pty",
      provider: "codex",
      ptyOwner: "local-terminal",
    });
  });

  it("reuses a managed local terminal when the Codex writer is its descendant", () => {
    const relaySend = vi.fn();
    const workerSpawn = vi.fn();
    const findCodexActiveWriter = vi.fn(() => ({ pid: 46559 }));
    const findClosestAncestorPid = vi.fn(() => 46546);
    const managed = {
      id: "managed-local-terminal",
      kind: "agent" as const,
      mode: "pty" as const,
      provider: "codex" as const,
      ptyOwner: "local-terminal" as const,
      state: SessionState.IDLE,
      cwd: "/tmp",
      pid: 46546,
      createdAt: 1,
      updatedAt: 1,
      // Legacy local resumes do not know which native Codex thread the TUI selected.
      historySessionId: undefined,
    };
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn,
      findCodexActiveWriter,
      findClosestAncestorPid,
      sessionManager: {
        listSessions: () => [managed],
      } as unknown as SessionManager,
    });
    router.handle({
      type: "session_create",
      requestId: "codex-managed-by-process-tree",
      cwd: "/tmp",
      provider: "codex",
      mode: "json",
      permissionMode: "auto",
      resumeSessionId: "019fa141-cdaf-78a2-a6c1-9cca04fb9f9a",
    });

    expect(workerSpawn).not.toHaveBeenCalled();
    expect(findClosestAncestorPid).toHaveBeenCalledWith(46559, [46546]);
    expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]))).toMatchObject({
      type: "session_create_response",
      requestId: "codex-managed-by-process-tree",
      sessionId: managed.id,
      mode: "pty",
      provider: "codex",
      ptyOwner: "local-terminal",
    });
  });

  it("waits for worker_ready before creating a JSON session", async () => {
    vi.useFakeTimers();
    const relaySend = vi.fn();
    const workerSpawn = vi.fn((_sessionId: string, _options?: unknown) => 1234);
    const workerSocket = createWritableSocketFake().socket;
    const createSession = vi.fn(() => ({
      id: "json-session",
      mode: "json",
      provider: "codex",
      state: SessionState.IDLE,
      cwd: "/tmp",
      pid: 1234,
      createdAt: 1,
      updatedAt: 1,
      name: "~/tmp",
      nameLocked: false,
    }));
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const workerWaitForReady = vi.fn(async (_sessionId: string, _timeoutMs?: number) => ready);
    const setHistorySessionId = vi.fn();
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn,
      workerConnect: async () => workerSocket,
      workerWaitForReady,
      workerTakePendingNativeSession: () => ({
        provider: "codex",
        sessionId: "codex-thread-ready",
      }),
      sessionManager: {
        createSession,
        setHistorySessionId,
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-json-ready",
      cwd: "/tmp",
      provider: "codex",
      mode: "json",
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(createSession).not.toHaveBeenCalled();
    expect(relaySend).not.toHaveBeenCalled();
    expect(workerWaitForReady).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
    const readyBudgetMs = workerWaitForReady.mock.calls[0][1];
    expect(readyBudgetMs).toBeGreaterThan(0);
    expect(readyBudgetMs).toBeLessThanOrEqual(SESSION_CREATE_SERVER_DEADLINE_MS);

    resolveReady();
    await vi.runAllTimersAsync();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(setHistorySessionId).toHaveBeenCalledWith("json-session", "codex-thread-ready");
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-json-ready",
      sessionId: "json-session",
      mode: "json",
      provider: "codex",
    });
  });

  it("returns a session_create_response when worker_ready fails after socket connect", async () => {
    vi.useFakeTimers();
    const relaySend = vi.fn();
    const cleanupHookContext = vi.fn();
    const workerTerminateProcess = vi.fn(() => true);
    const router = createRouter({
      mode: "json",
      relaySend,
      workerConnect: async () => createWritableSocketFake().socket,
      workerWaitForReady: async () => {
        throw new Error("Codex initialize timed out");
      },
      workerTerminateProcess,
      cleanupHookContext,
      sessionManager: {
        createSession: vi.fn(),
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-json-fail-ready",
      cwd: "/tmp",
      provider: "codex",
      mode: "json",
    });
    await vi.advanceTimersByTimeAsync(100);

    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-json-fail-ready",
      errorCode: ControlErrorCode.WORKER_START_FAILED,
      error: "Agent 进程启动失败，请检查 Agent CLI 配置后重试",
    });
    expect(workerTerminateProcess).toHaveBeenCalledTimes(1);
    expect(cleanupHookContext).toHaveBeenCalledTimes(1);
  });

  it("classifies an app-server active-writer startup race instead of returning a generic error", async () => {
    vi.useFakeTimers();
    const relaySend = vi.fn();
    const threadId = "019fa141-cdaf-78a2-a6c1-9cca04fb9f9a";
    const router = createRouter({
      mode: "json",
      relaySend,
      workerConnect: async () => createWritableSocketFake().socket,
      workerWaitForReady: async () => {
        throw new WorkerStartupError(
          `Error: thread ${threadId} already has an active writer`,
          ControlErrorCode.SESSION_ALREADY_ACTIVE,
          threadId,
        );
      },
      findCodexActiveWriter: () => ({ pid: 46559 }),
      sessionManager: {
        createSession: vi.fn(),
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-json-active-writer-race",
      cwd: "/tmp",
      provider: "codex",
      mode: "json",
      permissionMode: "auto",
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]))).toMatchObject({
      type: "session_create_response",
      requestId: "create-json-active-writer-race",
      errorCode: ControlErrorCode.SESSION_ALREADY_ACTIVE,
      activeWriterPid: 46559,
      error: expect.stringContaining("不会自动终止"),
    });
  });

  it("does not publish a session if the worker exits after ready", async () => {
    vi.useFakeTimers();
    const relaySend = vi.fn();
    const createSession = vi.fn();
    const workerTerminateProcess = vi.fn(() => false);
    const router = createRouter({
      mode: "json",
      relaySend,
      workerConnect: async () => createWritableSocketFake().socket,
      workerWaitForReady: async () => {},
      workerHas: () => false,
      workerTerminateProcess,
      sessionManager: { createSession } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-json-exited-after-ready",
      cwd: "/tmp",
      provider: "claude",
      mode: "json",
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(createSession).not.toHaveBeenCalled();
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-json-exited-after-ready",
      errorCode: ControlErrorCode.WORKER_START_FAILED,
    });
    expect(workerTerminateProcess).toHaveBeenCalledTimes(1);
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

  it("creates Kimi as a hookless hosted PTY", () => {
    const relaySend = vi.fn();
    const hostedStart = vi.fn((_options: unknown) => 1234);
    const createHookContext = vi.fn();
    const pushCommandList = vi.fn();
    const router = createRouter({
      mode: "pty",
      relaySend,
      hostedStart,
      createHookContext,
      pushCommandList,
      sessionManager: {
        listSessions: () => [],
        createSession: vi.fn(
          (
            _mode: unknown,
            cwd: string,
            pid: number,
            name: string | undefined,
            id: string,
            provider: "kimi",
          ) => ({
            id,
            mode: "pty",
            provider,
            ptyOwner: "proxy-hosted",
            state: SessionState.IDLE,
            cwd,
            pid,
            createdAt: 1,
            updatedAt: 1,
            name,
          }),
        ),
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-kimi-pty",
      cwd: "/tmp",
      provider: "kimi",
      mode: "pty",
      permissionMode: "plan",
    });

    expect(createHookContext).not.toHaveBeenCalled();
    expect(pushCommandList).not.toHaveBeenCalled();
    expect(hostedStart).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "kimi", permissionMode: "plan", hook: undefined }),
    );
    expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]))).toMatchObject({
      type: "session_create_response",
      requestId: "create-kimi-pty",
      provider: "kimi",
      mode: "pty",
    });
  });

  it("creates Kimi as a hookless ACP JSON session", async () => {
    const relaySend = vi.fn();
    const workerSpawn = vi.fn(() => 1234);
    const createHookContext = vi.fn();
    const pushCommandList = vi.fn();
    const controlCleanup = vi.fn();
    const setHistorySessionId = vi.fn();
    const createSession = vi.fn(
      (
        _mode: unknown,
        cwd: string,
        pid: number,
        name: string | undefined,
        id: string,
        provider: "kimi",
      ) => ({
        id,
        mode: "json" as const,
        provider,
        state: SessionState.IDLE,
        cwd,
        pid,
        createdAt: 1,
        updatedAt: 1,
        name,
        nameLocked: false,
      }),
    );
    const router = createRouter({
      mode: "json",
      relaySend,
      workerSpawn,
      workerConnect: async () => createWritableSocketFake().socket,
      workerWaitForReady: async () => {},
      workerTakePendingNativeSession: () => ({
        provider: "kimi",
        sessionId: "session_kimi_native",
      }),
      createHookContext,
      pushCommandList,
      controlCleanup,
      sessionManager: {
        listSessions: () => [],
        createSession,
        setHistorySessionId,
      } as unknown as SessionManager,
    });
    const pushHistoryMessages = vi
      .spyOn(
        (
          router as unknown as {
            sessionCreateHandler: {
              pushHistoryMessages: (sessionId: string, resumeSessionId: string) => void;
            };
          }
        ).sessionCreateHandler,
        "pushHistoryMessages",
      )
      .mockImplementation(() => {});

    router.handle({
      type: "session_create",
      requestId: "create-kimi-json",
      cwd: "/tmp",
      provider: "kimi",
      mode: "json",
      resumeSessionId: "session_kimi_native",
    });

    await vi.waitFor(() => expect(relaySend).toHaveBeenCalled());

    expect(workerSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        provider: "kimi",
        hook: undefined,
        resumeSessionId: "session_kimi_native",
      }),
    );
    expect(createHookContext).not.toHaveBeenCalled();
    expect(pushCommandList).not.toHaveBeenCalled();
    expect(controlCleanup).not.toHaveBeenCalled();
    expect(setHistorySessionId).toHaveBeenCalledWith(expect.any(String), "session_kimi_native");
    expect(pushHistoryMessages).toHaveBeenCalledWith(expect.any(String), "session_kimi_native");
    expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]))).toMatchObject({
      type: "session_create_response",
      requestId: "create-kimi-json",
      provider: "kimi",
      mode: "json",
    });
  });

  it("rejects Claude-only permission modes for Kimi before spawning a PTY", () => {
    const relaySend = vi.fn();
    const hostedStart = vi.fn((_options: unknown) => 1234);
    const router = createRouter({ mode: "pty", relaySend, hostedStart });

    router.handle({
      type: "session_create",
      requestId: "create-kimi-invalid-permission",
      cwd: "/tmp",
      provider: "kimi",
      mode: "pty",
      permissionMode: "acceptEdits",
    });

    expect(hostedStart).not.toHaveBeenCalled();
    expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]))).toMatchObject({
      type: "session_create_response",
      requestId: "create-kimi-invalid-permission",
      errorCode: ControlErrorCode.APPROVAL_POLICY_UNSUPPORTED,
    });
  });

  it("requests Kimi file resources without Claude command discovery", () => {
    const handleSessionResourcesRequest = vi.fn();
    const router = createRouter({
      mode: "pty",
      handleSessionResourcesRequest,
      sessionManager: {
        getSession: vi.fn(() => ({
          id: "kimi-1",
          mode: "pty",
          provider: "kimi",
          state: SessionState.IDLE,
          cwd: "/tmp/project",
          pid: 1234,
          createdAt: 1,
          updatedAt: 1,
        })),
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_resources_request",
      requestId: "resources-kimi-1",
      sessionId: "kimi-1",
    });

    expect(handleSessionResourcesRequest).toHaveBeenCalledWith({
      sessionId: "kimi-1",
      requestId: "resources-kimi-1",
      workDir: "/tmp/project",
      includeCommands: false,
    });
  });

  it("creates a pure shell terminal as a restart-surviving terminal worker", () => {
    const relaySend = vi.fn();
    const hostedStart = vi.fn(() => 4321);
    const terminalWorkerStart = vi.fn((_options: unknown) => 5678);
    const createSession = vi.fn(
      (_mode: unknown, sessionCwd: string, pid: number, name: string) => ({
        id: "terminal-session",
        kind: "terminal",
        mode: "pty",
        provider: "claude",
        ptyOwner: "local-terminal",
        state: SessionState.IDLE,
        cwd: sessionCwd,
        pid,
        createdAt: 1,
        updatedAt: 1,
        name,
      }),
    );
    const router = createRouter({
      mode: "pty",
      relaySend,
      hostedStart,
      terminalWorkerStart,
      sessionManager: {
        createSession,
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-terminal-1",
      kind: "terminal",
      mode: "pty",
    });

    expect(hostedStart).not.toHaveBeenCalled();
    const terminalOptions = terminalWorkerStart.mock.calls[0][0] as {
      sessionId: string;
      cwd: string;
      name: string;
    };
    const terminalName = tildify(terminalOptions.cwd);
    expect(terminalOptions).toEqual(
      expect.objectContaining({
        sessionId: expect.any(String),
        name: terminalName,
      }),
    );
    expect(createSession).toHaveBeenCalledWith(
      "pty",
      terminalOptions.cwd,
      5678,
      terminalName,
      expect.any(String),
      "claude",
      "local-terminal",
      false,
      "terminal",
    );
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-terminal-1",
      sessionId: "terminal-session",
      kind: "terminal",
      mode: "pty",
      ptyOwner: "local-terminal",
      name: terminalName,
    });
  });

  it("records Codex hosted PTY resume history id during session_create", () => {
    const setHistorySessionId = vi.fn();
    const setClaudeSessionId = vi.fn();
    const createSession = vi.fn(() => ({
      id: "codex-pty-session",
      mode: "pty",
      provider: "codex",
      ptyOwner: "proxy-hosted",
      state: SessionState.IDLE,
      cwd: "/tmp",
      pid: 1234,
      createdAt: 1,
      updatedAt: 1,
    }));
    const router = createRouter({
      mode: "pty",
      sessionManager: {
        listSessions: () => [],
        createSession,
        setClaudeSessionId,
        setHistorySessionId,
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-codex-pty-resume",
      cwd: "/tmp",
      provider: "codex",
      mode: "pty",
      resumeSessionId: "codex-native-thread",
    });

    expect(setHistorySessionId).toHaveBeenCalledWith("codex-pty-session", "codex-native-thread");
    expect(setClaudeSessionId).not.toHaveBeenCalled();
  });

  it("returns a session_create_response when hosted PTY startup fails", () => {
    const relaySend = vi.fn();
    const cleanupHookContext = vi.fn();
    const hostedAbortStartup = vi.fn(() => false);
    let pendingId = "";
    const router = createRouter({
      mode: "pty",
      relaySend,
      cleanupHookContext,
      hostedAbortStartup,
      hostedStart: vi.fn((options: unknown) => {
        pendingId = (options as { sessionId: string }).sessionId;
        mkdirSync(sessionPaths(pendingId).dir, { recursive: true });
        throw new Error("spawn EBADF");
      }),
    });

    router.handle({
      type: "session_create",
      requestId: "create-fail-1",
      cwd: "/tmp",
      provider: "claude",
      mode: "pty",
    });

    expect(relaySend).toHaveBeenCalledTimes(1);
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-fail-1",
      errorCode: ControlErrorCode.PROCESS_START_FAILED,
      error: "spawn EBADF",
    });
    expect(hostedAbortStartup).toHaveBeenCalledWith(pendingId);
    expect(cleanupHookContext).toHaveBeenCalledWith(pendingId);
    expect(existsSync(sessionPaths(pendingId).dir)).toBe(false);
  });

  it("aborts a hosted PTY if session publication fails after spawn", () => {
    const relaySend = vi.fn();
    const cleanupHookContext = vi.fn();
    const hostedAbortStartup = vi.fn(() => true);
    let pendingId = "";
    const router = createRouter({
      mode: "pty",
      relaySend,
      cleanupHookContext,
      hostedAbortStartup,
      hostedStart: vi.fn((options: unknown) => {
        pendingId = (options as { sessionId: string }).sessionId;
        return 1234;
      }),
      sessionManager: {
        createSession: vi.fn(() => {
          throw new Error("session persistence failed");
        }),
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-fail-after-spawn",
      cwd: "/tmp",
      provider: "claude",
      mode: "pty",
    });

    expect(hostedAbortStartup).toHaveBeenCalledWith(pendingId);
    expect(cleanupHookContext).toHaveBeenCalledWith(pendingId);
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-fail-after-spawn",
      errorCode: ControlErrorCode.PROCESS_START_FAILED,
      error: "session persistence failed",
    });
  });

  it("persists a requested session_create title as a locked display name", () => {
    const relaySend = vi.fn();
    const hostedStart = vi.fn((_options: unknown) => 1234);
    const createSession = vi.fn(() => ({
      id: "created-session",
      mode: "pty",
      provider: "codex",
      ptyOwner: "proxy-hosted",
      state: SessionState.IDLE,
      cwd: "/tmp",
      pid: 1234,
      createdAt: 1,
      updatedAt: 1,
      name: "Release checklist",
      nameLocked: true,
    }));
    const router = createRouter({
      mode: "pty",
      relaySend,
      hostedStart,
      sessionManager: {
        createSession,
        setClaudeSessionId: vi.fn(),
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_create",
      requestId: "create-1",
      cwd: "/tmp",
      provider: "codex",
      mode: "pty",
      name: "  Release checklist  ",
    });

    expect(createSession).toHaveBeenCalledWith(
      "pty",
      "/tmp",
      1234,
      "Release checklist",
      expect.any(String),
      "codex",
      "proxy-hosted",
      true,
    );
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "session_create_response",
      requestId: "create-1",
      sessionId: "created-session",
      name: "Release checklist",
      nameLocked: true,
    });
  });

  it("renames a session through relay and broadcasts the updated session list", () => {
    const relay = createRelayConnectionFake();
    const renameSession = vi.fn(() => ({ success: true, name: "Release checklist" }));
    const broadcastSessionList = vi.fn();
    const router = createRouter({
      mode: "json",
      relayConnection: relay,
      relaySend: relay.sendRaw,
      broadcastSessionList,
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
        renameSession,
      } as unknown as SessionManager,
    });

    router.handle({
      type: "session_rename",
      requestId: "rename-1",
      sessionId: "s1",
      name: "  Release checklist  ",
    });

    expect(renameSession).toHaveBeenCalledWith("s1", "  Release checklist  ");
    expect(broadcastSessionList).toHaveBeenCalledTimes(1);
    const msg = RelayControlSchema.parse(JSON.parse(relay.raw[0]!));
    expect(msg).toMatchObject({
      type: "session_rename_response",
      requestId: "rename-1",
      sessionId: "s1",
      success: true,
      name: "Release checklist",
    });
  });

  it("routes voice summary requests to the proxy-side summary runner", async () => {
    const relaySend = vi.fn();
    const voiceSummaryRunner: VoiceSummaryRunner = vi.fn(async () => "已总结代码变更和下一步。");
    const router = createRouter({
      mode: "json",
      relaySend,
      voiceSummaryRunner,
    });

    router.handle({
      type: "voice_summary_request",
      requestId: "voice-summary-1",
      sessionId: "s1",
      messageId: "m1",
      reason: "code",
      text: "```ts\nconst ok = true;\n```",
    });

    await vi.waitFor(() => expect(relaySend).toHaveBeenCalledTimes(1));
    expect(voiceSummaryRunner).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp", timeoutMs: 12_000 }),
    );
    const msg = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0][0]));
    expect(msg).toMatchObject({
      type: "voice_summary_response",
      requestId: "voice-summary-1",
      sessionId: "s1",
      messageId: "m1",
      success: true,
      summary: "已总结代码变更和下一步。",
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

  it("preserves remote_input_raw traceId through PTY IPC", () => {
    const terminalWrite = vi.fn();
    const router = createRouter({ mode: "pty", terminalWrite });

    router.handle({
      type: "remote_input_raw",
      sessionId: "s1",
      data: "a",
      traceId: "trace-1",
    });

    const ipc = parseIpc(terminalWrite.mock.calls[0][0] as string);
    expect(ipc.type).toBe("pty_input");
    if (ipc.type === "pty_input") {
      expect(ipc.traceId).toBe("trace-1");
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

  it("routes remote file upload stream controls to the upload manager", () => {
    const remoteFileUploadManager = createRemoteFileUploadManagerFake();
    const router = createRouter({ mode: "json", remoteFileUploadManager });

    router.handle({
      type: "remote_file_upload_stream_request",
      uploadId: "upload-1",
      sessionId: "s1",
      kind: "file",
      mimeType: "text/plain",
      fileName: "notes.txt",
    });
    router.handle({ type: "remote_file_upload_stream_complete", uploadId: "upload-1" });
    router.handle({ type: "remote_file_upload_stream_cancel", uploadId: "upload-2" });

    expect(remoteFileUploadManager.start).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "upload-1" }),
    );
    expect(remoteFileUploadManager.complete).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "upload-1" }),
    );
    expect(remoteFileUploadManager.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "upload-2" }),
    );
  });
});
