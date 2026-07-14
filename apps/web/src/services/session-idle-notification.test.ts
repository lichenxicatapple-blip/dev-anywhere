import type { SessionInfo } from "@dev-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { showBrowserNotification } = vi.hoisted(() => ({
  showBrowserNotification: vi.fn(),
}));

vi.mock("@/lib/browser-notifications", () => ({
  showBrowserNotification,
}));

import { isBusyToIdleTransition, notifySessionIdleTransition } from "./session-idle-notification";
import { useAppStore } from "@/stores/app-store";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "session-1",
    kind: "terminal",
    name: "/home/dev/projects/sample-app/",
    cwd: "/home/dev/projects/sample-app/",
    state: "working",
    mode: "pty",
    provider: "codex",
    lastActive: 100,
    ...overrides,
  };
}

describe("session idle notifications", () => {
  beforeEach(() => {
    localStorage.clear();
    showBrowserNotification.mockReset();
    showBrowserNotification.mockResolvedValue(true);
    useAppStore.setState({
      selectedProxyId: "proxy-1",
      selectedProxyName: "Work Mac",
      sessionIdleNotificationsEnabled: false,
    });
  });

  it("recognizes only fresh busy-to-idle transitions", () => {
    expect(isBusyToIdleTransition(makeSession(), "idle", 101)).toBe(true);
    expect(isBusyToIdleTransition(makeSession({ state: "compacting" }), "idle", 101)).toBe(true);
    expect(isBusyToIdleTransition(makeSession({ state: "idle" }), "idle", 101)).toBe(false);
    expect(isBusyToIdleTransition(makeSession({ state: "waiting_approval" }), "idle", 101)).toBe(
      false,
    );
    expect(isBusyToIdleTransition(makeSession(), "error", 101)).toBe(false);
    expect(isBusyToIdleTransition(makeSession(), "idle", 99)).toBe(false);
  });

  it("does nothing while the setting is off", async () => {
    await expect(notifySessionIdleTransition(makeSession(), "idle", 101)).resolves.toBe(false);

    expect(showBrowserNotification).not.toHaveBeenCalled();
  });

  it("shows a notification with the session and proxy context when enabled", async () => {
    useAppStore.setState({ sessionIdleNotificationsEnabled: true });

    await expect(notifySessionIdleTransition(makeSession(), "idle", 101)).resolves.toBe(true);

    expect(showBrowserNotification).toHaveBeenCalledTimes(1);
    expect(showBrowserNotification).toHaveBeenCalledWith({
      title: "会话已空闲",
      body: "~/projects/sample-app · Work Mac",
      tag: "dev-anywhere-session-idle:proxy-1:session-1:101",
      url: "http://localhost:3000/#/chat/session-1?mode=pty",
    });
  });
});
