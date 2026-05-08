import { serviceLogger } from "../common/logger.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { RelaySend } from "./relay-router-types.js";
import { readSessionMessages } from "./session-history.js";
import type { SessionManager } from "./session-manager.js";

interface RelayHistoryHandlersDeps {
  relaySend: RelaySend;
  sessionManager: SessionManager;
  permissionBroker: PermissionBroker;
}

export class RelayHistoryHandlers {
  constructor(private readonly deps: RelayHistoryHandlersDeps) {}

  onSessionMessagesRequest(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    if (!sid) return;
    const requestId = msg.requestId as string | undefined;

    const session = this.deps.sessionManager.getSession(sid);
    if (session?.claudeSessionId) {
      readSessionMessages(session.claudeSessionId)
        .then((messages) => {
          this.deps.relaySend(
            JSON.stringify({
              type: "session_history_messages",
              requestId,
              sessionId: sid,
              messages,
            }),
          );
          serviceLogger.info(
            { sessionId: sid, messageCount: messages.length },
            "History messages sent on request",
          );
        })
        .catch((err) => {
          serviceLogger.warn(
            { sessionId: sid, error: String(err) },
            "Failed to read session history messages on request",
          );
          this.deps.relaySend(
            JSON.stringify({
              type: "session_history_messages",
              requestId,
              sessionId: sid,
              messages: [],
            }),
          );
        });
    } else {
      this.deps.relaySend(
        JSON.stringify({
          type: "session_history_messages",
          requestId,
          sessionId: sid,
          messages: [],
        }),
      );
    }

    const approvals = this.deps.permissionBroker.listSession(sid).map((approval) => ({
      requestId: approval.requestId,
      toolName: approval.toolName,
      input: approval.input,
    }));
    this.deps.relaySend(
      JSON.stringify({ type: "pending_approvals_push", sessionId: sid, approvals }),
    );
    serviceLogger.info({ sessionId: sid, count: approvals.length }, "Pending approvals pushed");
  }
}
