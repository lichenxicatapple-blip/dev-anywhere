import {
  buildMessage,
  serializeControl,
  SessionState,
  type AgentStatusPayload,
  type ProviderId,
} from "@dev-anywhere/shared";
import { createScopedApprovalRequestIdFactory } from "../common/approval-request-id.js";
import { getSeqCounterFor } from "../common/seq-counter.js";
import { serviceLogger } from "../common/logger.js";
import type { RelayConnection } from "./relay-connection.js";
import type { AuthenticatedHookEvent } from "./hook-server.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";

type AgentStatusEvent = Omit<AuthenticatedHookEvent, "provider"> & { provider: ProviderId };

interface HookEventRouterDeps {
  relayConnection: RelayConnection;
  agentStatusRegistry: AgentStatusRegistry;
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
  // Retained for callers that also use the router for PTY hook providers.
  getSessionMode?: (sessionId: string) => "json" | "pty" | undefined;
  nextSeq?: (sessionId: string) => number;
}

import { toolInputFromPayload, toolNameFromPayload } from "./hook-payload-helpers.js";

export class HookEventRouter {
  private readonly nextFallbackRequestId = createScopedApprovalRequestIdFactory();

  constructor(private readonly deps: HookEventRouterDeps) {}

  handle(event: AuthenticatedHookEvent): void {
    switch (event.event) {
      case "SessionStart":
        this.deps.changeSessionState(event.sessionId, SessionState.IDLE);
        this.forwardAgentStatus(event, "idle");
        break;
      case "UserPromptSubmit":
        this.deps.changeSessionState(event.sessionId, SessionState.WORKING);
        this.forwardAgentStatus(event, "thinking");
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        this.deps.changeSessionState(event.sessionId, SessionState.WORKING);
        this.forwardAgentStatus(event, "outputting");
        break;
      case "Stop":
        this.deps.changeSessionState(event.sessionId, SessionState.IDLE);
        this.forwardAgentStatus(event, "idle");
        break;
      case "PermissionRequest":
        this.forwardPermissionRequest(event);
        break;
      case "PreToolUse":
        this.forwardToolUse(event);
        break;
      default:
        serviceLogger.debug(
          { sessionId: event.sessionId, provider: event.provider, event: event.event },
          "Unknown provider hook event ignored",
        );
        break;
    }
  }

  onPermissionResolved(
    sessionId: string,
    provider: ProviderId,
    requestId: string,
    outcome: "allow" | "deny",
    context?: {
      toolName?: string;
      toolInput?: Record<string, unknown>;
      hasPendingApprovals?: boolean;
    },
  ): void {
    // Hook providers end a denied turn, while ACP uses reject options for both a tool denial and
    // interactive answers such as "Skip". Kimi continues the same prompt after either outcome;
    // prompt result/error/interruption is the only authority that returns it to IDLE.
    const waitsForApproval = context?.hasPendingApprovals === true;
    const continuesPrompt = outcome === "allow" || provider === "kimi";
    this.deps.changeSessionState(
      sessionId,
      waitsForApproval
        ? SessionState.WAITING_APPROVAL
        : continuesPrompt
          ? SessionState.WORKING
          : SessionState.IDLE,
    );
    this.forwardAgentStatus(
      {
        sessionId,
        provider,
        event: "PermissionResolved",
        requestId,
        payload: {},
      },
      waitsForApproval
        ? "waiting_permission"
        : outcome === "allow"
          ? "tool_use"
          : provider === "kimi"
            ? "thinking"
            : "idle",
      {
        toolName: context?.toolName,
        toolInput: context?.toolInput,
        permissionResolution: { requestId, outcome },
      },
    );
    serviceLogger.info({ sessionId, requestId, outcome }, "Hook permission resolved");
  }

  private forwardPermissionRequest(event: AuthenticatedHookEvent): void {
    const requestId = event.requestId ?? this.nextFallbackRequestId(event.sessionId);
    const toolName = toolNameFromPayload(event.payload);
    const input = toolInputFromPayload(event.payload);

    this.deps.changeSessionState(event.sessionId, SessionState.WAITING_APPROVAL);
    this.forwardAgentStatus(event, "waiting_permission", {
      toolName,
      toolInput: input,
      permissionRequest: {
        requestId,
        toolName,
        input,
      },
    });

    const seq = this.deps.nextSeq?.(event.sessionId) ?? getSeqCounterFor(event.sessionId).next();
    const envelope = buildMessage(
      "tool_use_request",
      event.sessionId,
      seq,
      {
        toolName,
        toolId: requestId,
        parameters: input,
      },
      "proxy",
    );
    this.deps.relayConnection.sendEnvelope(envelope);
  }

  private forwardToolUse(event: AuthenticatedHookEvent): void {
    const toolName = toolNameFromPayload(event.payload);
    const input = toolInputFromPayload(event.payload);
    this.forwardAgentStatus(event, "tool_use", {
      toolName,
      toolInput: input,
    });
  }

  private forwardAgentStatus(
    event: AgentStatusEvent,
    phase: AgentStatusPayload["phase"],
    extra?: Partial<AgentStatusPayload>,
  ): void {
    const payload: AgentStatusPayload = {
      provider: event.provider,
      phase,
      seq: this.nextSeq(event.sessionId),
      updatedAt: Date.now(),
      ...extra,
    };
    this.deps.agentStatusRegistry.set(event.sessionId, payload);
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "agent_status",
        sessionId: event.sessionId,
        payload,
      }),
    );
  }

  private nextSeq(sessionId: string): number {
    return this.deps.nextSeq?.(sessionId) ?? getSeqCounterFor(sessionId).next();
  }
}
