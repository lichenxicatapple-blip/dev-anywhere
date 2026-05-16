import { buildMessage, serializeControl, SessionState } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionInfo, SessionManager } from "./session-manager.js";

const ACTIVITY_STATUS_PUSH_INTERVAL_MS = 15_000;

function toSessionListPayload(s: SessionInfo) {
  return {
    sessionId: s.id,
    mode: s.mode,
    provider: s.provider,
    ...(s.ptyOwner !== undefined ? { ptyOwner: s.ptyOwner } : {}),
    state: s.state,
    lastActive: s.updatedAt,
    cwd: s.cwd,
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.nameLocked !== undefined ? { nameLocked: s.nameLocked } : {}),
  };
}

function pushSessionStatus(
  relay: RelayConnection,
  sessionManager: SessionManager,
  sessionId: string,
): void {
  const session = sessionManager.getSession(sessionId);
  if (!session) return;
  try {
    const envelope = buildMessage(
      "session_status",
      session.id,
      Date.now(),
      { sessionId: session.id, state: session.state, lastActive: session.updatedAt },
      "proxy",
    );
    relay.sendEnvelope(envelope);
  } catch (err) {
    serviceLogger.debug({ sessionId, error: String(err) }, "Failed to push session_status");
  }
}

export function broadcastSessionList(relay: RelayConnection, sessionManager: SessionManager): void {
  // session_list 是 envelope（payload 携带 sessions 数组），走 buildMessage 才能保证
  // version / timestamp / source 字段与其它 envelope 一致；旧代码手写 version: "1" 与
  // buildMessage 默认的 "1.0" 不符，会让任何对 envelope schema 严格校验的地方报错。
  const envelope = buildMessage(
    "session_list",
    null,
    0,
    { sessions: sessionManager.listSessions().map(toSessionListPayload) },
    "proxy",
  );
  relay.sendEnvelope(envelope);
}

export function broadcastSessionSync(relay: RelayConnection, session: SessionInfo): void {
  relay.sendRaw(
    serializeControl({
      type: "session_sync",
      sessions: [
        {
          id: session.id,
          mode: session.mode,
          provider: session.provider,
          ...(session.ptyOwner !== undefined ? { ptyOwner: session.ptyOwner } : {}),
          cwd: session.cwd,
          ...(session.name !== undefined ? { name: session.name } : {}),
          ...(session.nameLocked !== undefined ? { nameLocked: session.nameLocked } : {}),
          state: session.state,
        },
      ],
    }),
  );
}

export function changeSessionState(
  sessionManager: SessionManager,
  relay: RelayConnection,
  sessionId: string,
  next: SessionState,
): boolean {
  if (!sessionManager.getSession(sessionId)) return false;
  const changed = sessionManager.updateState(sessionId, next);
  if (changed) pushSessionStatus(relay, sessionManager, sessionId);
  return changed;
}

export function touchSessionActivity(
  sessionManager: SessionManager,
  relay: RelayConnection,
  sessionId: string,
  now: number = Date.now(),
): boolean {
  const touched = sessionManager.touchSession(sessionId, now, ACTIVITY_STATUS_PUSH_INTERVAL_MS);
  if (touched) pushSessionStatus(relay, sessionManager, sessionId);
  return touched;
}
