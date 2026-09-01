import { serializeControl, type ApprovalOption, type ControlMessage } from "@dev-anywhere/shared";
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

function decisionOptionId(payload: object): string | undefined {
  const value = "optionId" in payload ? payload.optionId : undefined;
  return typeof value === "string" && value ? value : undefined;
}

function validateDecisionOption(
  options: ApprovalOption[] | undefined,
  optionId: string | undefined,
  behavior: "allow" | "deny",
): string | null {
  if (!options?.length) {
    return optionId ? "The selected permission option is not available." : null;
  }
  if (!optionId) return "A permission option must be selected.";
  const option = options.find((candidate) => candidate.optionId === optionId);
  if (!option) return "The selected permission option is no longer available.";
  const expectedPrefix = behavior === "allow" ? "allow_" : "reject_";
  if (!option.kind.startsWith(expectedPrefix)) {
    return `The selected permission option cannot ${behavior} this request.`;
  }
  return null;
}

export class RelayPermissionHandlers {
  constructor(private readonly deps: RelayPermissionHandlersDeps) {}

  onToolApprove(msg: ControlMessage<"tool_approve">): void {
    const { sessionId, payload } = msg;
    if (!sessionId || !payload?.toolId) return;
    const optionId = decisionOptionId(payload);

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
    const optionError = validateDecisionOption(pending.options, optionId, "allow");
    if (optionError) {
      this.resolveInvalidOption(pending, payload.toolId, optionError);
      return;
    }
    if (
      !this.deps.permissionBroker.resolve(payload.toolId, {
        behavior: "allow",
        ...(payload.whitelistTool ? { remember: true } : {}),
        ...(optionId ? { optionId } : {}),
      })
    ) {
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
      {
        toolName: pending.toolName,
        toolInput: pending.input,
        ...(this.hasPendingApprovals(pending.sessionId) ? { hasPendingApprovals: true } : {}),
      },
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

  onToolDeny(msg: ControlMessage<"tool_deny">): void {
    const { sessionId, payload } = msg;
    if (!sessionId || !payload?.toolId) return;
    const optionId = decisionOptionId(payload);

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
    const optionError = validateDecisionOption(pending.options, optionId, "deny");
    if (optionError) {
      this.resolveInvalidOption(pending, payload.toolId, optionError);
      return;
    }
    if (
      !this.deps.permissionBroker.resolve(payload.toolId, {
        behavior: "deny",
        message: reason,
        ...(optionId ? { optionId } : {}),
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
      {
        toolName: pending.toolName,
        toolInput: pending.input,
        ...(this.hasPendingApprovals(pending.sessionId) ? { hasPendingApprovals: true } : {}),
      },
    );
    this.pushPermissionDecisionResult(pending.sessionId, payload.toolId, "deny", true, reason);
    serviceLogger.info({ sessionId, toolId: payload.toolId }, "Tool denied via relay");
  }

  onPermissionRequestDelivered(msg: ControlMessage<"permission_request_delivered">): void {
    const { sessionId: sid, requestId } = msg;
    if (!sid || !requestId) return;
    const marked = this.deps.permissionBroker.markDelivered(requestId);
    serviceLogger.info({ sessionId: sid, requestId, marked }, "Permission request delivered");
  }

  private resolveInvalidOption(
    pending: NonNullable<ReturnType<PermissionBroker["get"]>>,
    requestId: string,
    message: string,
  ): void {
    const resolved = this.deps.permissionBroker.resolve(requestId, {
      behavior: "deny",
      message,
    });
    if (!resolved) {
      this.pushPermissionDecisionResult(
        pending.sessionId,
        requestId,
        "deny",
        false,
        "Permission request is no longer pending.",
      );
      return;
    }
    this.deps.hookEventRouter.onPermissionResolved(
      pending.sessionId,
      pending.provider,
      requestId,
      "deny",
      {
        toolName: pending.toolName,
        toolInput: pending.input,
        ...(this.hasPendingApprovals(pending.sessionId) ? { hasPendingApprovals: true } : {}),
      },
    );
    this.pushPermissionDecisionResult(pending.sessionId, requestId, "deny", true, message);
    serviceLogger.warn(
      { sessionId: pending.sessionId, requestId, provider: pending.provider, message },
      "Invalid permission option failed closed",
    );
  }

  private hasPendingApprovals(sessionId: string): boolean {
    return this.deps.permissionBroker.listSession(sessionId).length > 0;
  }

  private pushPermissionDecisionResult(
    sessionId: string,
    requestId: string,
    outcome: "allow" | "deny",
    delivered: boolean,
    message?: string,
  ): void {
    this.deps.relaySend(
      serializeControl({
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
