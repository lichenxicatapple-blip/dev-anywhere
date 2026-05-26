import { serializeControl, type ControlMessage } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { RelaySend } from "./relay-router-types.js";
import { readSessionMessagesPage } from "./session-history.js";
import type { SessionManager } from "./session-manager.js";
import type { SessionInfo } from "./session-manager.js";

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
    if (session?.claudeSessionId || session?.historySessionId) {
      readSessionHistoryPageForSession(session, { before, limit })
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

interface HistoryPageOptions {
  limit?: number;
  before?: string;
}

interface SessionHistoryMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: number;
  cursor?: string;
}

interface SessionHistoryPage {
  messages: SessionHistoryMessage[];
  hasMore: boolean;
  nextBefore?: string;
}

const RESUME_CURSOR_PREFIX = "resume:";
const ACTIVE_CURSOR_PREFIX = "active:";

function addCursorPrefix(
  prefix: typeof RESUME_CURSOR_PREFIX | typeof ACTIVE_CURSOR_PREFIX,
  messages: SessionHistoryMessage[],
): SessionHistoryMessage[] {
  return messages.map((message) =>
    message.cursor ? { ...message, cursor: `${prefix}${message.cursor}` } : message,
  );
}

function stripCursorPrefix(
  prefix: typeof RESUME_CURSOR_PREFIX | typeof ACTIVE_CURSOR_PREFIX,
  cursor: string,
): string {
  return cursor.startsWith(prefix) ? cursor.slice(prefix.length) : cursor;
}

async function readSessionHistoryPageForSession(
  session: SessionInfo,
  options: HistoryPageOptions,
): Promise<SessionHistoryPage> {
  const historySessionId = session.historySessionId;
  const activeSessionId = session.claudeSessionId;
  const hasSeparateHistory =
    historySessionId !== undefined &&
    activeSessionId !== undefined &&
    historySessionId !== activeSessionId;

  if (!hasSeparateHistory) {
    const sourceId = activeSessionId ?? historySessionId;
    if (!sourceId) return { messages: [], hasMore: false };
    return readSessionMessagesPage(sourceId, options, session.provider);
  }

  if (options.before?.startsWith(ACTIVE_CURSOR_PREFIX)) {
    const page = await readSessionMessagesPage(
      activeSessionId,
      {
        ...options,
        before: stripCursorPrefix(ACTIVE_CURSOR_PREFIX, options.before),
      },
      session.provider,
    );
    return {
      ...page,
      messages: addCursorPrefix(ACTIVE_CURSOR_PREFIX, page.messages),
      ...(page.nextBefore !== undefined
        ? { nextBefore: `${ACTIVE_CURSOR_PREFIX}${page.nextBefore}` }
        : {}),
    };
  }

  if (options.before?.startsWith(RESUME_CURSOR_PREFIX)) {
    const page = await readSessionMessagesPage(
      historySessionId,
      {
        ...options,
        before: stripCursorPrefix(RESUME_CURSOR_PREFIX, options.before),
      },
      session.provider,
    );
    return {
      ...page,
      messages: addCursorPrefix(RESUME_CURSOR_PREFIX, page.messages),
      ...(page.nextBefore !== undefined
        ? { nextBefore: `${RESUME_CURSOR_PREFIX}${page.nextBefore}` }
        : {}),
    };
  }

  const [historyPage, activePage] = await Promise.all([
    readSessionMessagesPage(historySessionId, options, session.provider),
    readSessionMessagesPage(activeSessionId, options, session.provider),
  ]);

  return {
    messages: [
      ...addCursorPrefix(RESUME_CURSOR_PREFIX, historyPage.messages),
      ...addCursorPrefix(ACTIVE_CURSOR_PREFIX, activePage.messages),
    ],
    hasMore: historyPage.hasMore,
    ...(historyPage.nextBefore !== undefined
      ? { nextBefore: `${RESUME_CURSOR_PREFIX}${historyPage.nextBefore}` }
      : {}),
  };
}
