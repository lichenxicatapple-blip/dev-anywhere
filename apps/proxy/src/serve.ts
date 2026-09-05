import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { serializeControl } from "@dev-anywhere/shared";
import { flushLogger } from "@dev-anywhere/shared/logger";
import { serviceLogger } from "./common/logger.js";
import { SessionManager } from "./serve/session-manager.js";
import { RelayConnection } from "./serve/relay-connection.js";
import {
  SOCK_PATH,
  PID_PATH,
  SERVICE_CONTROL_PATH,
  STOPPED_PATH,
  SESSIONS_PATH,
  SESSION_RUNTIME_IPC_VERSION_PATH,
  HISTORY_METADATA_PATH,
  PROXY_ID_PATH,
  PROFILE_NAME,
  PREVIEWS_PATH,
  PREVIEW_RUN_DIR,
  ensureProfileWorkspace,
  sessionPaths,
} from "./common/paths.js";
import { buildProviderEnv, loadConfig } from "./common/config.js";
import {
  serializeIpc,
  TERMINAL_IPC_PROTOCOL_VERSION,
  WORKER_IPC_PROTOCOL_VERSION,
} from "./ipc/ipc-protocol.js";
import {
  readSessionRuntimeIpcVersions,
  sessionRuntimeIpcVersionMatches,
  writeSessionRuntimeIpcVersions,
} from "./common/session-runtime-ipc-version.js";
import { createControlMessageHandlers } from "./serve/handlers/control-messages.js";
import { WorkerRegistry } from "./serve/worker-registry.js";
import { RelayRouter } from "./serve/relay-router.js";
import { JsonObserver } from "./serve/json-observer.js";
import { PermissionBroker } from "./serve/permission-broker.js";
import { HookEventRouter } from "./serve/hook-event-router.js";
import { AgentStatusRegistry } from "./serve/agent-status-registry.js";
import { TerminalWorkerSpawner } from "./serve/terminal-worker-spawner.js";
import { broadcastSessionList, broadcastSessionSync } from "./serve/session-broadcast.js";
import { createEventBridge } from "./serve/event-bridge.js";
import { claimServiceRuntime, getProxyName } from "./serve/service-files.js";
import { handleTerminalConnection } from "./serve/terminal-ipc.js";
import { createTerminalIpcAdmissionController } from "./serve/terminal-ipc-admission.js";
import { createProviderHookRuntime } from "./serve/provider-hook-runtime.js";
import { createServeShutdown } from "./serve/shutdown.js";
import { RemoteFileUploadManager } from "./serve/remote-file-upload.js";
import { RemoteFileStreamManager } from "./serve/remote-file-stream.js";
import { TerminalSubscriptionBacklog } from "./serve/terminal-subscription-backlog.js";
import type { ProviderId } from "./providers/types.js";
import { createRelayAutoUpdater } from "./auto-update.js";
import { createRelayUpgradeBootstrapMonitor } from "./relay-upgrade-bootstrap.js";
import { selectHighestStableVersion } from "./common/stable-version.js";
import { PROXY_VERSION } from "./version.js";
import { PreviewManager } from "./serve/preview/preview-manager.js";
import { cleanupStalePreviewRuntimes } from "./serve/preview/stale-preview-runtime.js";
import { DefaultDevicePreviewBackend } from "./serve/device-preview/default-device-preview-backend.js";
import { DevicePreviewManager } from "./serve/device-preview/device-preview-manager.js";
import { DevicePreviewStreamConnection } from "./serve/device-preview/device-preview-stream-connection.js";
import { startServiceControl } from "./common/service-control.js";
import {
  removeLocalIpcEndpoint,
  setLocalIpcEndpointPermissions,
} from "./common/local-ipc-endpoint.js";

const AGENT_CLI_PATH_FIELDS: Record<ProviderId, "claudeBin" | "codexBin" | "kimiBin"> = {
  claude: "claudeBin",
  codex: "codexBin",
  kimi: "kimiBin",
};

function resolveInterruptedApprovals(
  permissionBroker: PermissionBroker,
  hookEventRouter: HookEventRouter,
  relay: RelayConnection,
  sessionId: string,
): void {
  const approvals = permissionBroker.listSession(sessionId);
  if (approvals.length === 0) return;

  const message = "Permission request was interrupted in the PTY.";
  for (const approval of approvals) {
    if (!permissionBroker.resolve(approval.requestId, { behavior: "deny", message })) continue;
    hookEventRouter.onPermissionResolved(
      approval.sessionId,
      approval.provider,
      approval.requestId,
      "deny",
      { toolName: approval.toolName, toolInput: approval.input },
    );
    relay.sendRaw(
      serializeControl({
        type: "permission_decision_result",
        sessionId: approval.sessionId,
        requestId: approval.requestId,
        outcome: "deny",
        delivered: true,
        message,
      }),
    );
  }
  serviceLogger.info(
    { sessionId, count: approvals.length },
    "Pending approvals cleared after PTY interruption",
  );
}

export interface ServiceOptions {
  relayUrl?: string;
  relayName?: string;
}

function parseServiceOptions(argv: readonly string[]): ServiceOptions {
  const options: ServiceOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--relay") {
      const relayName = argv[i + 1];
      if (!relayName || relayName.startsWith("-")) {
        throw new Error("Missing value for --relay");
      }
      options.relayName = relayName;
      i++;
      continue;
    }
    if (arg.startsWith("--relay=")) {
      const relayName = arg.slice("--relay=".length);
      if (!relayName) throw new Error("Missing value for --relay");
      options.relayName = relayName;
      continue;
    }
  }
  return options;
}

export async function startService(options?: ServiceOptions): Promise<void> {
  ensureProfileWorkspace();
  await claimServiceRuntime();
  const instanceId = randomUUID();
  await cleanupStalePreviewRuntimes(PREVIEW_RUN_DIR);

  const permissionBroker = new PermissionBroker((sessionId) => {
    const socket = terminalSockets.get(sessionId);
    if (socket?.writable) {
      socket.write(
        serializeIpc({
          type: "pty_approval_context",
          sessionId,
          waiting: permissionBroker.listSession(sessionId).length > 0,
        }),
      );
    }
  });
  const agentStatusRegistry = new AgentStatusRegistry();
  let unregisterHookSession: (sessionId: string) => void = () => {};
  // SessionManager 在构造期会清理磁盘中的失效记录；此时 relay/control runtime 尚未建立。
  // runtime 就绪后再接入统一清理出口，让手动终止、worker 退出、reaper 和 PTY 关闭
  // 都通过同一条 onSessionRemoved 生命周期完成资源回收与 session_list 广播。
  let cleanupRemovedSessionRuntime: (sessionId: string) => void = () => {};
  const currentSessionRuntimeIpcVersions = {
    terminal: TERMINAL_IPC_PROTOCOL_VERSION,
    worker: WORKER_IPC_PROTOCOL_VERSION,
  };
  const previousSessionRuntimeIpcVersions = readSessionRuntimeIpcVersions(
    SESSION_RUNTIME_IPC_VERSION_PATH,
  );
  const allowSessionRuntimeHandover = {
    terminal: sessionRuntimeIpcVersionMatches(
      previousSessionRuntimeIpcVersions,
      currentSessionRuntimeIpcVersions,
      "terminal",
    ),
    worker: sessionRuntimeIpcVersionMatches(
      previousSessionRuntimeIpcVersions,
      currentSessionRuntimeIpcVersions,
      "worker",
    ),
  };
  const sessionManager = new SessionManager({
    persistPath: SESSIONS_PATH,
    historyMetadataPath: HISTORY_METADATA_PATH,
    allowSessionRuntimeHandover,
    onSessionRemoved: (id, context) => {
      if (!context?.preserveProviderHooks) {
        unregisterHookSession(id);
      }
      const paths = sessionPaths(id);
      try {
        rmSync(paths.dir, { recursive: true, force: true });
      } catch {
        // 会话目录清理失败不影响主流程
      }
      cleanupRemovedSessionRuntime(id);
    },
  });
  // Publish the current generation only after SessionManager has finished validating persisted
  // runtime records. If startup is interrupted before this write, the next daemon refuses
  // handover rather than adopting an unverified process.
  writeSessionRuntimeIpcVersions(
    SESSION_RUNTIME_IPC_VERSION_PATH,
    currentSessionRuntimeIpcVersions,
  );
  sessionManager.startReaper();

  const terminalSockets = new Map<string, Socket>();
  const terminalClaims = new Map<string, Socket>();
  const proxyName = getProxyName();

  // 连接中转服务器：优先用调用方传入的 relayUrl，否则从配置文件读取
  // relay 是 proxy 存在的必要前提，未配置直接 fail-fast，不再支持"本地独立"模式
  let proxyConfig = loadConfig({ relayName: options?.relayName });
  const getProviderEnv = (): NodeJS.ProcessEnv => buildProviderEnv(proxyConfig, process.env);
  const getAgentCliSuggestions = (): Partial<Record<ProviderId, string[]>> =>
    proxyConfig.agentCliSuggestions;
  const setAgentCliPath = (provider: ProviderId, path: string): void => {
    const field = AGENT_CLI_PATH_FIELDS[provider];
    const existing = proxyConfig.agentCliSuggestions[provider] ?? [];
    proxyConfig = {
      ...proxyConfig,
      [field]: path,
      agentCliSuggestions: {
        ...proxyConfig.agentCliSuggestions,
        [provider]: [path, ...existing.filter((candidate) => candidate !== path)],
      },
      sources: {
        ...proxyConfig.sources,
        [field]: "file",
      },
    };
  };
  const relayUrl = options?.relayUrl ?? proxyConfig.relayUrl;
  const relayToken = proxyConfig.relayToken;
  const statusConfig = {
    profile: PROFILE_NAME,
    version: PROXY_VERSION,
    autoUpdate: proxyConfig.autoUpdate,
    relayName: proxyConfig.relayName,
    relayNameSource: proxyConfig.sources.relayName,
    relayUrl,
    relayUrlSource: proxyConfig.sources.relayUrl,
    relayTokenSource: proxyConfig.sources.relayToken,
    hookPort: proxyConfig.hookPort ?? 17654,
    hookPortSource: proxyConfig.sources.hookPort,
  };
  if (!relayUrl) {
    const msg = `Relay URL is required. Set relays.${proxyConfig.relayName}.url in ~/.dev-anywhere/config.json or pass --relay <name>.`;
    serviceLogger.error(msg);
    console.error(msg);
    await flushLogger(serviceLogger);
    process.exit(1);
  }
  const relayConnection = new RelayConnection(relayUrl, {
    name: proxyName,
    token: relayToken,
    version: PROXY_VERSION,
    proxyIdPath: PROXY_ID_PATH,
  });
  const autoUpdater = createRelayAutoUpdater({
    enabled: proxyConfig.autoUpdate,
    profileName: PROFILE_NAME,
    relayName: proxyConfig.relayName,
    runningVersion: PROXY_VERSION,
    logger: serviceLogger,
  });
  let serviceReadyForAutoUpdate = false;
  let pendingRelayVersion: string | null = null;
  const considerRelayVersion = (version: string): void => {
    pendingRelayVersion = selectHighestStableVersion(pendingRelayVersion, version);
    if (serviceReadyForAutoUpdate) autoUpdater.considerRelayVersion(version);
  };
  const upgradeBootstrap = createRelayUpgradeBootstrapMonitor({
    relayUrl,
    token: relayToken,
    logger: serviceLogger,
    onAdmission: (event) => {
      if (event.relayVersion) considerRelayVersion(event.relayVersion);
      relayConnection.applyProtocolAdmission(event.direction);
    },
  });
  relayConnection.on("relay_version", considerRelayVersion);
  relayConnection.on("connected", () => upgradeBootstrap.markControlProtocolConnected());
  relayConnection.on("disconnected", () => upgradeBootstrap.request());
  relayConnection.on("protocol_blocked", (event: { source: string }) => {
    if (event.source !== "http_bootstrap") upgradeBootstrap.request();
  });
  upgradeBootstrap.request();
  const relaySend = (data: string): void => relayConnection.sendRaw(data);
  const previewManager = new PreviewManager({
    persistPath: PREVIEWS_PATH,
    runtimeRoot: PREVIEW_RUN_DIR,
    onEvent: (event) => {
      relaySend(
        serializeControl(
          event.type === "state"
            ? {
                type: "preview_state_event",
                epoch: event.epoch,
                revision: event.revision,
                preview: event.preview,
              }
            : {
                type: "preview_removed_event",
                epoch: event.epoch,
                revision: event.revision,
                previewId: event.previewId,
              },
        ),
      );
    },
  });
  const devicePreviewStream = new DevicePreviewStreamConnection({
    relayUrl,
    proxyId: relayConnection.getProxyId(),
    token: relayToken,
    onFlow: (streamId, paused, resyncRequired) =>
      devicePreviewManager.setFlowPaused(streamId, paused, resyncRequired),
  });
  const devicePreviewManager = new DevicePreviewManager({
    backend: new DefaultDevicePreviewBackend(),
    streamTransport: {
      sendFrame: (streamId, frameSequence, jpeg) =>
        devicePreviewStream.sendFrame(streamId, frameSequence, jpeg),
      sendH264Packet: (streamId, packetSequence, packet) =>
        devicePreviewStream.sendH264Packet(streamId, packetSequence, packet),
      sendComplete: (payload) => {
        relaySend(
          serializeControl({
            type: "device_preview_stream_complete",
            ...payload,
          }),
        );
      },
    },
    onEvent: (event) => {
      relaySend(
        serializeControl(
          event.type === "state"
            ? {
                type: "device_preview_state_event",
                epoch: event.epoch,
                revision: event.revision,
                preview: event.preview,
              }
            : {
                type: "device_preview_removed_event",
                epoch: event.epoch,
                revision: event.revision,
                previewId: event.previewId,
              },
        ),
      );
    },
  });
  const controlHandlers = createControlMessageHandlers(relaySend, sessionManager);

  const eventBridge = createEventBridge({
    sessionManager,
    relayConnection,
    agentStatusRegistry,
    controlHandlers,
    permissionBroker,
  });
  cleanupRemovedSessionRuntime = (sessionId) => {
    terminalClaims.delete(sessionId);
    eventBridge.cleanupSessionResources(sessionId);
  };
  const jsonObserver = new JsonObserver({
    changeSessionState: eventBridge.changeSessionState,
    emitAgentStatus: eventBridge.emitAgentStatus,
  });
  const hookRuntime = await createProviderHookRuntime({
    hookPort: proxyConfig.hookPort,
    permissionBroker,
    sessionManager,
    relayConnection,
    agentStatusRegistry,
    changeSessionState: eventBridge.changeSessionState,
  });
  unregisterHookSession = (sessionId) => hookRuntime.hookRegistry.unregisterSession(sessionId);

  // WorkerRegistry 建在 relay 之后、listener 之前；构造期订阅 envelope_dropped 事件
  const workerRegistry = new WorkerRegistry({
    sessionManager,
    permissionBroker,
    relayConnection,
    jsonObserver,
    touchSessionActivity: eventBridge.touchSessionActivity,
    getProviderEnv,
    setProviderCommands: (sessionId, commands) =>
      controlHandlers.setProviderCommands(sessionId, commands),
  });
  const terminalWorkerSpawner = new TerminalWorkerSpawner();
  const terminalSubscriptionBacklog = new TerminalSubscriptionBacklog();
  const remoteFileStreamManager = new RemoteFileStreamManager({
    relayConnection,
    sessionManager,
  });
  const remoteFileUploadManager = new RemoteFileUploadManager({
    relayConnection,
    sessionManager,
  });

  relayConnection.on("stream_connection", (connectionId: string) => {
    devicePreviewStream.register(connectionId);
  });

  relayConnection.connect();
  serviceLogger.info(
    {
      relayName: proxyConfig.relayName,
      profile: PROFILE_NAME,
      relayUrl,
      proxyName,
      tokenSet: !!relayToken,
      relayUrlSource: proxyConfig.sources.relayUrl,
    },
    "Connecting to relay server",
  );

  const relayRouter = new RelayRouter({
    sessionManager,
    workerRegistry,
    controlHandlers,
    relayConnection,
    relaySend,
    terminalSockets,
    terminalWorkerSpawner,
    broadcastSessionList: () => broadcastSessionList(relayConnection, sessionManager),
    broadcastSessionSync: () => broadcastSessionSync(relayConnection, sessionManager),
    jsonObserver,
    createHookContext: hookRuntime.createHookContext,
    cleanupHookContext: (sessionId) => hookRuntime.hookRegistry.unregisterSession(sessionId),
    permissionBroker,
    hookEventRouter: hookRuntime.hookEventRouter,
    agentStatusRegistry,
    getProviderEnv,
    getAgentCliSuggestions,
    setAgentCliPath,
    remoteFileStreamManager,
    remoteFileUploadManager,
    terminalSubscriptionBacklog,
    previewManager,
    devicePreviewManager,
  });

  relayConnection.on("message", (msg: Record<string, unknown>) => relayRouter.handle(msg));
  relayConnection.on("binary", (data: Buffer) => {
    if (!remoteFileUploadManager.handleBinary(data)) {
      serviceLogger.warn({ bytes: data.length }, "Relay binary message dropped: unknown frame");
    }
  });
  relayConnection.on("connected", () => {
    // fire-and-forget 但显式吞掉 rejection，否则 reinitializeOnReconnect 内部任意 IO 异常
    // 或 schema 校验错误会变 unhandledRejection，Node 默认终止整个 serve 进程。
    // 失败影响面: agent-cli-status / proxy_register_response 后的状态推送丢失, client 在
    // reconnect 后看到陈旧状态。属于服务降级而非健康降级, 用 error 级别让 ops 能接到告警。
    void controlHandlers.reinitializeOnReconnect().catch((err: unknown) => {
      serviceLogger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "reinitializeOnReconnect failed: client may see stale state until next manual sync",
      );
    });
    broadcastBridgeStatus(true);
  });
  relayConnection.on("disconnected", () => {
    devicePreviewStream.disconnectMain();
    devicePreviewManager.disconnectTransport();
    broadcastBridgeStatus(false);
  });

  // 把 relay 连接状态广播给所有已注册的 terminal，终端进程会 stderr 打 banner 提示用户
  function broadcastBridgeStatus(connected: boolean): void {
    const msg = serializeIpc({ type: "bridge_status", connected });
    for (const [, sock] of terminalSockets) {
      if (sock.writable) sock.write(msg);
    }
  }

  await workerRegistry.reconnectAll();

  const terminalAdmission = createTerminalIpcAdmissionController({
    terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
    logger: serviceLogger,
  });
  const terminalConnectionDeps = {
    sessionManager,
    terminalSockets,
    terminalClaims,
    terminalSubscriptionBacklog,
    relayConnection,
    permissionBroker,
    hookEventRouter: hookRuntime.hookEventRouter,
    createHookContext: hookRuntime.createTerminalHookContext,
    getProviderEnv,
    emitAgentStatus: eventBridge.emitAgentStatus,
    updateTerminalCwd: eventBridge.updateTerminalCwd,
    resolveInterruptedApprovals: (sessionId: string) =>
      resolveInterruptedApprovals(
        permissionBroker,
        hookRuntime.hookEventRouter,
        relayConnection,
        sessionId,
      ),
  };
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    terminalAdmission.handle(socket, (admission) => {
      handleTerminalConnection(socket, terminalConnectionDeps, admission);
    });
    socket.resume();
  });

  // Do not resolve startup until the IPC socket is actually listening. In particular, a listen
  // failure must reach the entry-point catch (and bounded service log) instead of becoming an
  // unhandled EventEmitter error while the parent CLI is polling an impossible readiness state.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(SOCK_PATH, () => {
      server.off("error", onError);
      try {
        writeFileSync(PID_PATH, String(process.pid));
        setLocalIpcEndpointPermissions(SOCK_PATH);
        serviceLogger.info({ pid: process.pid, sock: SOCK_PATH }, "Service started");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

  let control: Awaited<ReturnType<typeof startServiceControl>> | undefined = undefined;
  let stopping = false;
  const shutdown = createServeShutdown({
    logger: serviceLogger,
    autoUpdaterDispose: () => {
      upgradeBootstrap.dispose();
      autoUpdater.dispose();
    },
    sessionManagerStopReaper: () => sessionManager.stopReaper(),
    relayRouterDestroy: () => relayRouter.destroy(),
    previewManagerShutdown: () => previewManager.shutdown(),
    devicePreviewManagerShutdown: () => devicePreviewManager.shutdown(),
    devicePreviewStreamClose: () => devicePreviewStream.close(),
    hookServerClose: () => hookRuntime.hookServer.close(),
    relayConnectionClose: () => relayConnection.close(),
    workerRegistryDestroyAll: () => workerRegistry.destroyAll(),
    terminalAdmissionDestroyAll: () => terminalAdmission.destroyAll(),
    ipcServerClose: () => server.close(),
    sockPath: SOCK_PATH,
    pidPath: PID_PATH,
    runtimeStateCleanup: () => {
      control?.close();
      removeLocalIpcEndpoint(SERVICE_CONTROL_PATH);
      removeLocalIpcEndpoint(SOCK_PATH);
      rmSync(PID_PATH, { force: true });
    },
  });

  const stop = () => {
    stopping = true;
    void shutdown();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  if (existsSync(STOPPED_PATH)) {
    await shutdown();
    return;
  }
  control = await startServiceControl({
    socketPath: SERVICE_CONTROL_PATH,
    onStop: stop,
    getStatus: () => ({
      pid: process.pid,
      instanceId,
      profile: PROFILE_NAME,
      version: PROXY_VERSION,
      state: stopping ? "stopping" : "ready",
      info: {
        config: statusConfig,
        relay: relayConnection.getStatus(),
        sessions: sessionManager.listSessions().map((s) => ({
          id: s.id,
          mode: s.mode,
          state: s.state,
          createdAt: new Date(s.createdAt).toISOString(),
          ...(s.name !== undefined ? { name: s.name } : {}),
          hasWorker: workerRegistry.has(s.id),
        })),
      },
    }),
  });
  serviceReadyForAutoUpdate = true;
  if (pendingRelayVersion) autoUpdater.considerRelayVersion(pendingRelayVersion);
}

const isMainModule =
  process.argv[1] && (process.argv[1].endsWith("serve.js") || process.argv[1].endsWith("serve.ts"));

if (isMainModule) {
  startService(parseServiceOptions(process.argv.slice(2))).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    serviceLogger.error({ err: message }, "Service failed to start");
    console.error(message);
    await flushLogger(serviceLogger);
    process.exit(1);
  });
}
