import type { SessionInfo } from "@dev-anywhere/shared";
import { showBrowserNotification } from "@/lib/browser-notifications";
import { formatSessionName, formatUnlockedTerminalPathName } from "@/lib/format-session-name";
import { useAppStore } from "@/stores/app-store";

const BUSY_SESSION_STATES = new Set<SessionInfo["state"]>(["working", "compacting"]);

export function isBusyToIdleTransition(
  previous: Pick<SessionInfo, "state" | "lastActive">,
  nextState: SessionInfo["state"],
  nextLastActive: number,
): boolean {
  if (!BUSY_SESSION_STATES.has(previous.state) || nextState !== "idle") return false;
  return previous.lastActive === undefined || nextLastActive >= previous.lastActive;
}

function sessionNotificationLabel(session: SessionInfo): string {
  const terminalPath = formatUnlockedTerminalPathName(session);
  if (terminalPath) return terminalPath;
  const formatted = formatSessionName(session.name ?? session.cwd);
  return formatted === "New Session" ? session.sessionId.slice(0, 8) : formatted;
}

export async function notifySessionIdleTransition(
  previous: SessionInfo,
  nextState: SessionInfo["state"],
  nextLastActive: number,
): Promise<boolean> {
  if (!isBusyToIdleTransition(previous, nextState, nextLastActive)) return false;

  const app = useAppStore.getState();
  if (!app.sessionIdleNotificationsEnabled) return false;

  const mode = previous.mode ?? "json";
  const url = new URL(
    `/#/chat/${encodeURIComponent(previous.sessionId)}?mode=${mode}`,
    window.location.origin,
  ).toString();
  const label = sessionNotificationLabel(previous);
  const body = app.selectedProxyName ? `${label} · ${app.selectedProxyName}` : label;

  return showBrowserNotification({
    title: "会话已空闲",
    body,
    tag: `dev-anywhere-session-idle:${app.selectedProxyId ?? "unknown"}:${previous.sessionId}:${nextLastActive}`,
    url,
  });
}
