import { serviceLogger } from "../common/logger.js";
import { HOOK_REGISTRY_PATH } from "../common/paths.js";
import type { ProviderHookContext } from "../providers/index.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import { HookEventRouter } from "./hook-event-router.js";
import { HookRegistry } from "./hook-registry.js";
import { HookServer } from "./hook-server.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";
import type { SessionState } from "@dev-anywhere/shared";

interface ProviderHookRuntimeOptions {
  hookPort?: number;
  permissionBroker: PermissionBroker;
  sessionManager: SessionManager;
  relayConnection: RelayConnection;
  agentStatusRegistry: AgentStatusRegistry;
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
}

interface ProviderHookRuntime {
  hookRegistry: HookRegistry;
  hookEventRouter: HookEventRouter;
  hookServer: HookServer;
  createHookContext: (
    sessionId: string,
    provider: ProviderHookContext["provider"],
  ) => ProviderHookContext;
}

export async function createProviderHookRuntime(
  options: ProviderHookRuntimeOptions,
): Promise<ProviderHookRuntime> {
  const hookRegistry = new HookRegistry({ persistPath: HOOK_REGISTRY_PATH });
  const hookEventRouter = new HookEventRouter({
    relayConnection: options.relayConnection,
    agentStatusRegistry: options.agentStatusRegistry,
    changeSessionState: options.changeSessionState,
  });
  const port = options.hookPort ?? 17654;
  const hookServer = new HookServer({
    port,
    registry: hookRegistry,
    permissionBroker: options.permissionBroker,
    isSessionActive: (sessionId) => !!options.sessionManager.getSession(sessionId),
    onEvent: (event) => {
      serviceLogger.info(
        {
          sessionId: event.sessionId,
          provider: event.provider,
          event: event.event,
          requestId: event.requestId,
        },
        "Provider hook event received",
      );
      hookEventRouter.handle(event);
    },
  });

  try {
    await hookServer.start();
  } catch (err) {
    const msg = `Failed to start hook server on 127.0.0.1:${port}: ${String(err)}`;
    serviceLogger.error(msg);
    console.error(msg);
    process.exit(1);
  }

  const hookUrl = `http://127.0.0.1:${hookServer.getListeningPort() ?? port}/hook`;
  const createHookContext: ProviderHookRuntime["createHookContext"] = (sessionId, provider) => {
    const credentials = hookRegistry.registerSession(sessionId, provider);
    return {
      provider,
      sessionId,
      hookUrl,
      marker: credentials.marker,
      token: credentials.token,
    };
  };

  return {
    hookRegistry,
    hookEventRouter,
    hookServer,
    createHookContext,
  };
}
