import { buildMessage, SessionState } from "@dev-anywhere/shared";
import { SeqCounter } from "../common/seq-counter.js";
import { serviceLogger } from "../common/logger.js";
import type { RelayConnection } from "./relay-connection.js";
import type { AuthenticatedHookEvent } from "./hook-server.js";

interface HookEventRouterDeps {
  relayConnection: RelayConnection;
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
  nextSeq?: (sessionId: string) => number;
}

function hookPayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolNameFromPayload(payload: Record<string, unknown>): string {
  return typeof payload.toolName === "string"
    ? payload.toolName
    : typeof payload.tool_name === "string"
      ? payload.tool_name
      : "unknown";
}

function toolInputFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return hookPayloadRecord(payload.input ?? payload.tool_input);
}

export class HookEventRouter {
  constructor(private readonly deps: HookEventRouterDeps) {}

  handle(event: AuthenticatedHookEvent): void {
    switch (event.event) {
      case "SessionStart":
        this.deps.changeSessionState(event.sessionId, SessionState.IDLE);
        break;
      case "UserPromptSubmit":
      case "PostToolUse":
      case "PostToolUseFailure":
        this.deps.changeSessionState(event.sessionId, SessionState.WORKING);
        break;
      case "Stop":
        this.deps.changeSessionState(event.sessionId, SessionState.IDLE);
        break;
      case "PermissionRequest":
      case "PreToolUse":
        this.forwardPermissionRequest(event);
        break;
      default:
        serviceLogger.debug(
          { sessionId: event.sessionId, provider: event.provider, event: event.event },
          "Unknown provider hook event ignored",
        );
        break;
    }
  }

  onPermissionResolved(sessionId: string, requestId: string, outcome: "allow" | "deny"): void {
    this.deps.changeSessionState(sessionId, SessionState.WORKING);
    serviceLogger.info({ sessionId, requestId, outcome }, "Hook permission resolved");
  }

  private forwardPermissionRequest(event: AuthenticatedHookEvent): void {
    const requestId = event.requestId ?? `${event.sessionId}:${Date.now()}`;
    const toolName = toolNameFromPayload(event.payload);
    const input = toolInputFromPayload(event.payload);

    this.deps.changeSessionState(event.sessionId, SessionState.WAITING_APPROVAL);

    const seq = this.deps.nextSeq?.(event.sessionId) ?? new SeqCounter(event.sessionId).next();
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
}
