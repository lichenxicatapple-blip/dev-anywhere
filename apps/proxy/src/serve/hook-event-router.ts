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
  // session.mode 决定审批解除后的转换目标：JSON 模式不允许 WAITING_APPROVAL → WORKING
  // （观察通道粒度问题，见 session-manager.ts JSON_TRANSITIONS 注释），需让 onTurnResult 直接 → IDLE。
  getSessionMode?: (sessionId: string) => "json" | "pty" | undefined;
  nextSeq?: (sessionId: string) => number;
}

import {
  toolInputFromPayload,
  toolNameFromPayload,
} from "./hook-payload-helpers.js";

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
    // 状态机走向按 outcome × mode 分四档（详见 session-manager.ts 的 JSON_TRANSITIONS / PTY_TRANSITIONS 边表）：
    //  - deny：双通道都直接回 IDLE，本轮终结
    //  - allow + PTY：claude 继续输出，OSC 信号将驱动后续状态，先 → WORKING
    //  - allow + JSON：观察粒度不到中间 WORKING，主动转换会被 FSM 拒绝；
    //    交给 onTurnResult 一次性 WAITING_APPROVAL → IDLE
    if (outcome === "deny") {
      this.deps.changeSessionState(sessionId, SessionState.IDLE);
    } else {
      const mode = this.deps.getSessionMode?.(sessionId);
      if (mode === "pty") {
        this.deps.changeSessionState(sessionId, SessionState.WORKING);
      }
      // mode === "json" 或 undefined：不主动转换状态，交给后续观察事件
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
