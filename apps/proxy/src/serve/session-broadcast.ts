import {
  buildMessage,
  serializeControl,
  SessionState,
  type ControlMessage,
  type SessionListPayload,
} from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionInfo, SessionManager } from "./session-manager.js";

const ACTIVITY_STATUS_PUSH_INTERVAL_MS = 15_000;

type SessionListEntry = SessionListPayload["sessions"][number];
type SessionSyncEntry = ControlMessage<"session_sync">["sessions"][number];

export function toSessionListPayload(s: SessionInfo): SessionListEntry {
  const common = {
    sessionId: s.id,
    state: s.state,
    lastActive: s.updatedAt,
    cwd: s.cwd,
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.nameLocked !== undefined ? { nameLocked: s.nameLocked } : {}),
  };
  if (s.kind === "terminal") {
    return {
      ...common,
      kind: "terminal",
      mode: "pty",
      provider: "claude",
      ptyOwner: "proxy-hosted",
    };
  }
  if (s.mode === "pty") {
    return {
      ...common,
      kind: "agent",
      mode: "pty",
      provider: s.provider,
      ptyOwner: s.ptyOwner,
    };
  }
  return { ...common, kind: "agent", mode: "json", provider: s.provider };
}

export function toSessionSyncEntry(s: SessionInfo): SessionSyncEntry {
  const common = {
    id: s.id,
    cwd: s.cwd,
    state: s.state,
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.nameLocked !== undefined ? { nameLocked: s.nameLocked } : {}),
  };
  if (s.kind === "terminal") {
    return {
      ...common,
      kind: "terminal",
      mode: "pty",
      provider: "claude",
      ptyOwner: "proxy-hosted",
    };
  }
  if (s.mode === "pty") {
    return {
      ...common,
      kind: "agent",
      mode: "pty",
      provider: s.provider,
      ptyOwner: s.ptyOwner,
    };
  }
  return { ...common, kind: "agent", mode: "json", provider: s.provider };
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
  // 统一通过 buildMessage 构造完整的 session_list envelope。
  const envelope = buildMessage(
    "session_list",
    null,
    0,
    { sessions: sessionManager.listSessions().map(toSessionListPayload) },
    "proxy",
  );
  relay.sendEnvelope(envelope);
}

/**
 * Replace Relay's proxy-to-session association with the complete in-memory snapshot.
 * `session_sync` is authoritative (Relay uses set semantics), so sending only the session that
 * changed would silently remove every other active association.
 */
export function broadcastSessionSync(relay: RelayConnection, sessionManager: SessionManager): void {
  relay.sendRaw(
    serializeControl({
      type: "session_sync",
      sessions: sessionManager.listSessions().map(toSessionSyncEntry),
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

export function changeTerminalCwd(
  sessionManager: SessionManager,
  relay: RelayConnection,
  sessionId: string,
  cwd: string,
): boolean {
  const changed = sessionManager.updateTerminalCwd(sessionId, cwd);
  if (changed) broadcastSessionList(relay, sessionManager);
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
