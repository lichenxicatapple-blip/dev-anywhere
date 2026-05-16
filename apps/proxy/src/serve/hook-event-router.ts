import {
  buildMessage,
  serializeControl,
  SessionState,
  type AgentStatusPayload,
} from "@dev-anywhere/shared";
import { getSeqCounterFor } from "../common/seq-counter.js";
import { serviceLogger } from "../common/logger.js";
import type { RelayConnection } from "./relay-connection.js";
import type { AuthenticatedHookEvent } from "./hook-server.js";
import type { HookProviderId } from "./hook-registry.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";

interface HookEventRouterDeps {
  relayConnection: RelayConnection;
  agentStatusRegistry: AgentStatusRegistry;
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
  // session.mode 决定审批解除后的转换目标：allow 后 PTY/JSON 都应回到 WORKING,
  // deny 则直接回 IDLE。
  getSessionMode?: (sessionId: string) => "json" | "pty" | undefined;
  nextSeq?: (sessionId: string) => number;
}

import { toolInputFromPayload, toolNameFromPayload } from "./hook-payload-helpers.js";

export class HookEventRouter {
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
    provider: HookProviderId,
    requestId: string,
    outcome: "allow" | "deny",
    context?: { toolName?: string; toolInput?: Record<string, unknown> },
  ): void {
    // 状态机走向按 outcome 分两档（详见 session-manager.ts 的 JSON_TRANSITIONS / PTY_TRANSITIONS 边表）：
    //  - deny：双通道都直接回 IDLE，本轮终结
    //  - allow：CLI/worker 已收到 control_response，agent 会继续跑，先 → WORKING
    if (outcome === "deny") {
      this.deps.changeSessionState(sessionId, SessionState.IDLE);
    } else {
      this.deps.changeSessionState(sessionId, SessionState.WORKING);
    }
    this.forwardAgentStatus(
      {
        sessionId,
        provider,
        event: "PermissionResolved",
        requestId,
        payload: {},
      },
      outcome === "allow" ? "tool_use" : "idle",
      {
        toolName: context?.toolName,
        toolInput: context?.toolInput,
        permissionResolution: { requestId, outcome },
      },
    );
    serviceLogger.info({ sessionId, requestId, outcome }, "Hook permission resolved");
  }

  private forwardPermissionRequest(event: AuthenticatedHookEvent): void {
    const requestId = event.requestId ?? `${event.sessionId}:${Date.now()}`;
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
    event: AuthenticatedHookEvent,
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
