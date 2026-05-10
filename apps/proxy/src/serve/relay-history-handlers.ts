import { serializeControl } from "@dev-anywhere/shared";
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

  onSessionMessagesRequest(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    if (!sid) return;
    const requestId = msg.requestId as string | undefined;
    const before = msg.before as string | undefined;
    const limit = msg.limit as number | undefined;

    const session = this.deps.sessionManager.getSession(sid);
    if (session?.claudeSessionId) {
      readSessionMessagesPage(session.claudeSessionId, { before, limit })
        .then((page) => {
          this.deps.relaySend(
            JSON.stringify({
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
            JSON.stringify({
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
        JSON.stringify({
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
