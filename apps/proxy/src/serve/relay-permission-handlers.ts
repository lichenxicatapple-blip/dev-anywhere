import { serviceLogger } from "../common/logger.js";
import type { HookEventRouter } from "./hook-event-router.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { RelaySend } from "./relay-router-types.js";
import type { WorkerRegistry } from "./worker-registry.js";

interface RelayPermissionHandlersDeps {
  relaySend: RelaySend;
  permissionBroker: PermissionBroker;
  hookEventRouter: HookEventRouter;
  workerRegistry: WorkerRegistry;
}

export class RelayPermissionHandlers {
  constructor(private readonly deps: RelayPermissionHandlersDeps) {}

  onToolApprove(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    const payload = msg.payload as { toolId?: string; whitelistTool?: boolean } | undefined;
    if (!sessionId || !payload?.toolId) return;

    const pending = this.deps.permissionBroker.get(payload.toolId);
    if (!pending) {
      this.pushPermissionDecisionResult(
        sessionId,
        payload.toolId,
        "allow",
        false,
        "Permission request is no longer pending.",
      );
      return;
    }
    if (!this.deps.permissionBroker.resolve(payload.toolId, { behavior: "allow" })) {
      this.pushPermissionDecisionResult(
        pending.sessionId,
        payload.toolId,
        "allow",
        false,
        "Permission request is no longer pending.",
      );
      return;
    }
    this.deps.hookEventRouter.onPermissionResolved(
      pending.sessionId,
      pending.provider,
      payload.toolId,
      "allow",
      { toolName: pending.toolName, toolInput: pending.input },
    );

    if (pending.source === "worker" && payload.whitelistTool) {
      const toolName = pending.toolName;
      if (toolName) {
        const whitelisted = this.deps.workerRegistry.send(pending.sessionId, {
          type: "worker_whitelist_add",
          toolName,
        });
        if (whitelisted) {
          serviceLogger.info(
            { sessionId: pending.sessionId, toolName },
            "Tool added to session whitelist via relay",
          );
        }
      }
    }
    this.pushPermissionDecisionResult(pending.sessionId, payload.toolId, "allow", true);
    serviceLogger.info(
      { sessionId, toolId: payload.toolId, whitelistTool: payload.whitelistTool },
      "Tool approved via relay",
    );
  }

  onToolDeny(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    const payload = msg.payload as { toolId?: string; reason?: string } | undefined;
    if (!sessionId || !payload?.toolId) return;

    const reason = payload.reason ?? "Denied by remote user";
    const pending = this.deps.permissionBroker.get(payload.toolId);
    if (!pending) {
      this.pushPermissionDecisionResult(
        sessionId,
        payload.toolId,
        "deny",
        false,
        "Permission request is no longer pending.",
      );
      return;
    }
    if (
      !this.deps.permissionBroker.resolve(payload.toolId, {
        behavior: "deny",
        message: reason,
      })
    ) {
      this.pushPermissionDecisionResult(
        pending.sessionId,
        payload.toolId,
        "deny",
        false,
        "Permission request is no longer pending.",
      );
      return;
    }
    this.deps.hookEventRouter.onPermissionResolved(
      pending.sessionId,
      pending.provider,
      payload.toolId,
      "deny",
      { toolName: pending.toolName, toolInput: pending.input },
    );
    this.pushPermissionDecisionResult(pending.sessionId, payload.toolId, "deny", true, reason);
    serviceLogger.info({ sessionId, toolId: payload.toolId }, "Tool denied via relay");
  }

  onPermissionRequestDelivered(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    const requestId = msg.requestId as string | undefined;
    if (!sid || !requestId) return;
    const marked = this.deps.permissionBroker.markDelivered(requestId);
    serviceLogger.info({ sessionId: sid, requestId, marked }, "Permission request delivered");
  }

  private pushPermissionDecisionResult(
    sessionId: string,
    requestId: string,
    outcome: "allow" | "deny",
    delivered: boolean,
    message?: string,
  ): void {
    this.deps.relaySend(
      JSON.stringify({
        type: "permission_decision_result",
        sessionId,
        requestId,
        outcome,
        delivered,
        ...(message ? { message } : {}),
      }),
    );
  }
}
