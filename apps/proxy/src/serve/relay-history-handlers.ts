import { serializeControl, type ControlMessage } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { RelaySend } from "./relay-router-types.js";
import { readSessionMessagesPage } from "./session-history.js";
import type { SessionManager } from "./session-manager.js";

interface RelayHistoryHandlersDeps {
  relaySend: RelaySend;
  sessionManager: SessionManager;
  permissionBroker: PermissionBroker;
}

export class RelayHistoryHandlers {
  constructor(private readonly deps: RelayHistoryHandlersDeps) {}

  onSessionMessagesRequest(msg: ControlMessage<"session_messages_request">): void {
    const { sessionId: sid, requestId, before, limit } = msg;
    if (!sid) return;

    const session = this.deps.sessionManager.getSession(sid);
    if (session?.claudeSessionId) {
      readSessionMessagesPage(session.claudeSessionId, { before, limit })
        .then((page) => {
          this.deps.relaySend(
            serializeControl({
              type: "session_history_messages",
              requestId,
              sessionId: sid,
              ...(before !== undefined ? { before } : {}),
              messages: page.messages,
              hasMore: page.hasMore,
              ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}),
            }),
          );
          serviceLogger.info(
            {
              sessionId: sid,
              before,
              hasMore: page.hasMore,
              nextBefore: page.nextBefore,
              messageCount: page.messages.length,
            },
            "History message page sent on request",
          );
        })
        .catch((err) => {
          serviceLogger.warn(
            { sessionId: sid, error: String(err) },
            "Failed to read session history page on request",
          );
          this.deps.relaySend(
            serializeControl({
              type: "session_history_messages",
              requestId,
              sessionId: sid,
              ...(before !== undefined ? { before } : {}),
              messages: [],
              hasMore: false,
            }),
          );
        });
    } else {
      this.deps.relaySend(
        serializeControl({
          type: "session_history_messages",
          requestId,
          sessionId: sid,
          ...(before !== undefined ? { before } : {}),
          messages: [],
          hasMore: false,
        }),
      );
    }

    const approvals = this.deps.permissionBroker.listSession(sid).map((approval) => ({
      requestId: approval.requestId,
      toolName: approval.toolName,
      input: approval.input,
    }));
    this.deps.relaySend(
      serializeControl({ type: "pending_approvals_push", sessionId: sid, approvals }),
    );
    serviceLogger.info({ sessionId: sid, count: approvals.length }, "Pending approvals pushed");
  }
}
