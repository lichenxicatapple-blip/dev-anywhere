import { createServer, type Socket } from "node:net";
import { unlinkSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { serializeControl } from "@dev-anywhere/shared";
import { flushLogger } from "@dev-anywhere/shared/logger";
import { serviceLogger } from "./common/logger.js";
import { SessionManager } from "./serve/session-manager.js";
import { RelayConnection } from "./serve/relay-connection.js";
import {
  SOCK_PATH,
  PID_PATH,
  STOPPED_PATH,
  SESSIONS_PATH,
  PROXY_ID_PATH,
  PROFILE_NAME,
  ensureProfileWorkspace,
  sessionPaths,
} from "./common/paths.js";
import { buildProviderEnv, loadConfig } from "./common/config.js";
import { serializeIpc } from "./ipc/ipc-protocol.js";
import { createControlMessageHandlers } from "./serve/handlers/control-messages.js";
import { WorkerRegistry } from "./serve/worker-registry.js";
import { RelayRouter } from "./serve/relay-router.js";
import { JsonObserver } from "./serve/json-observer.js";
import { PermissionBroker } from "./serve/permission-broker.js";
import { HookEventRouter } from "./serve/hook-event-router.js";
import { AgentStatusRegistry } from "./serve/agent-status-registry.js";
import { HostedPtyRegistry } from "./serve/hosted-pty-registry.js";
import {
  applyPtyStateToSession,
  type PtySessionBridgeDeps,
} from "./serve/pty-session-bridge.js";
import { broadcastSessionList, broadcastSessionSync } from "./serve/session-broadcast.js";
import { createEventBridge } from "./serve/event-bridge.js";
import { cleanupStaleResources, getProxyName } from "./serve/service-files.js";
import { handleTerminalConnection } from "./serve/terminal-ipc.js";
import { createProviderHookRuntime } from "./serve/provider-hook-runtime.js";
import { createServeShutdown } from "./serve/shutdown.js";
import type { ProviderId } from "./providers/types.js";

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
    }
  }
  return options;
}

export async function startService(options?: ServiceOptions): Promise<void> {
  ensureProfileWorkspace();
  await cleanupStaleResources();
  try {
    unlinkSync(STOPPED_PATH);
  } catch {
    // STOPPED 文件不存在时忽略
  }

  const permissionBroker = new PermissionBroker();
  const agentStatusRegistry = new AgentStatusRegistry();
  let unregisterHookSession: (sessionId: string) => void = () => {};
  const sessionManager = new SessionManager({
    persistPath: SESSIONS_PATH,
    onSessionRemoved: (id, context) => {
      if (!context?.preserveProviderHooks) {
        unregisterHookSession(id);
      }
      permissionBroker.cleanupSession(id, "session removed");
      agentStatusRegistry.delete(id);
      const paths = sessionPaths(id);
      try {
        rmSync(paths.dir, { recursive: true, force: true });
      } catch {
        // 会话目录清理失败不影响主流程
      }
    },
  });
  sessionManager.startReaper();

  const terminalSockets = new Map<string, Socket>();
  const proxyName = getProxyName();

  // 连接中转服务器：优先用调用方传入的 relayUrl，否则从配置文件读取
  // relay 是 proxy 存在的必要前提，未配置直接 fail-fast，不再支持"本地独立"模式
  let proxyConfig = loadConfig({ relayName: options?.relayName });
  const getProviderEnv = (): NodeJS.ProcessEnv => buildProviderEnv(proxyConfig, process.env);
  const getAgentCliSuggestions = (): Partial<Record<ProviderId, string[]>> =>
    proxyConfig.agentCliSuggestions;
  const getPreviewRoots = (): string[] => proxyConfig.previewRoots;
  const setAgentCliPath = (provider: ProviderId, path: string): void => {
    const field = provider === "claude" ? "claudeBin" : "codexBin";
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
    proxyIdPath: PROXY_ID_PATH,
  });
  const relaySend = (data: string): void => relayConnection.sendRaw(data);
  const controlHandlers = createControlMessageHandlers(relaySend, sessionManager);

  const eventBridge = createEventBridge({
    sessionManager,
    relayConnection,
    agentStatusRegistry,
    controlHandlers,
    permissionBroker,
  });
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
  });
  const ptyBridgeDeps: PtySessionBridgeDeps = {
    changeSessionState: eventBridge.changeSessionState,
    getSession: (sessionId) => sessionManager.getSession(sessionId),
    getPendingApprovalCount: (sessionId) => permissionBroker.listSession(sessionId).length,
    resolveInterruptedApprovals: (sessionId) =>
      resolveInterruptedApprovals(
        permissionBroker,
        hookRuntime.hookEventRouter,
        relayConnection,
        sessionId,
      ),
    emitAgentStatus: eventBridge.emitAgentStatus,
  };
  const hostedPtyRegistry = new HostedPtyRegistry({
    sessionManager,
    relayConnection,
    getProviderEnv,
    touchSessionActivity: eventBridge.touchSessionActivity,
    applyPtyStateToSession: (sessionId, ptyState) =>
      applyPtyStateToSession(ptyBridgeDeps, sessionId, ptyState),
    onSessionClosed: eventBridge.cleanupSessionResources,
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
    hostedPtyRegistry,
    broadcastSessionList: () => broadcastSessionList(relayConnection, sessionManager),
    broadcastSessionSync: (session) => broadcastSessionSync(relayConnection, session),
    jsonObserver,
    createHookContext: hookRuntime.createHookContext,
    cleanupHookContext: (sessionId) => hookRuntime.hookRegistry.unregisterSession(sessionId),
    permissionBroker,
    hookEventRouter: hookRuntime.hookEventRouter,
    agentStatusRegistry,
    getProviderEnv,
    getAgentCliSuggestions,
    setAgentCliPath,
    getPreviewRoots,
  });

  relayConnection.on("message", (msg: Record<string, unknown>) => relayRouter.handle(msg));
  relayConnection.on("connected", () => {
    // fire-and-forget 但显式吞掉 rejection，否则 reinitializeOnReconnect 内部任意 IO 异常
    // 或 schema 校验错误会变 unhandledRejection，Node 默认终止整个 serve 进程。
    // 失败影响面: agent-cli-status / proxy_register_response 后的状态推送丢失, client 在
    // reconnect 后看到陈旧状态。属于服务降级而非健康降级, 用 error 级别让 ops 能接到告警。
    void controlHandlers.reinitializeOnReconnect().catch((err: unknown) => {
      serviceLogger.error(
        { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
        "reinitializeOnReconnect failed: client may see stale state until next manual sync",
      );
    });
    broadcastBridgeStatus(true);
  });
  relayConnection.on("disconnected", () => {
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

  const server = createServer((socket) => {
    handleTerminalConnection(socket, {
      sessionManager,
      workerRegistry,
      terminalSockets,
      hostedPtyRegistry,
      relayConnection,
      controlHandlers,
      agentStatusRegistry,
      permissionBroker,
      hookEventRouter: hookRuntime.hookEventRouter,
      createHookContext: hookRuntime.createHookContext,
      emitAgentStatus: eventBridge.emitAgentStatus,
      cleanupSessionResources: eventBridge.cleanupSessionResources,
      config: statusConfig,
      resolveInterruptedApprovals: (sessionId) =>
        resolveInterruptedApprovals(
          permissionBroker,
          hookRuntime.hookEventRouter,
          relayConnection,
          sessionId,
        ),
    });
  });

  server.listen(SOCK_PATH, () => {
    writeFileSync(PID_PATH, String(process.pid));
    chmodSync(SOCK_PATH, 0o600);
    serviceLogger.info({ pid: process.pid, sock: SOCK_PATH }, "Service started");
  });

  const shutdown = createServeShutdown({
    logger: serviceLogger,
    sessionManagerStopReaper: () => sessionManager.stopReaper(),
    relayRouterDestroy: () => relayRouter.destroy(),
    hookServerClose: () => hookRuntime.hookServer.close(),
    relayConnectionClose: () => relayConnection.close(),
    workerRegistryDestroyAll: () => workerRegistry.destroyAll(),
    hostedPtyRegistryDestroyAll: () => hostedPtyRegistry.destroyAll(),
    ipcServerClose: () => server.close(),
    sockPath: SOCK_PATH,
    pidPath: PID_PATH,
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
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
