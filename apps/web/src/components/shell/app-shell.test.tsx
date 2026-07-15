import { cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@dev-anywhere/shared";

const { sendRawSpy } = vi.hoisted(() => ({
  sendRawSpy: vi.fn(),
}));

vi.mock("@/components/shell/sidebar", () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}));

vi.mock("@/components/shell/settings-dialog", () => ({
  SettingsDialog: () => null,
}));

vi.mock("@/components/brand/mobile-brand-hero", () => ({
  MobileBrandHero: () => null,
}));

vi.mock("@/components/diagnostics/latency-monitor", () => ({
  LatencyMonitor: () => null,
}));

vi.mock("@/components/toast", () => ({
  Toaster: () => null,
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/ansi-keys", () => ({
  sendRemoteInputRaw: sendRawSpy,
}));

import { AppShell } from "./app-shell";
import { useAppStore } from "@/stores/app-store";
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";

function makePtySession(sessionId: string): SessionInfo {
  return {
    sessionId,
    mode: "pty",
    provider: "codex",
    state: "idle",
    ptyOwner: "local-terminal",
  };
}

function setSessionState(sessionId: string, state: SessionInfo["state"]): void {
  useSessionStore.setState((store) => ({
    sessions: store.sessions.map((session) =>
      session.sessionId === sessionId ? { ...session, state } : session,
    ),
  }));
}

function renderAppShell(initialEntry: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppShell />,
        children: [
          { path: "chat/:id", element: <div data-testid="chat-route" /> },
          { path: "sessions", element: <div data-testid="sessions-route" /> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("AppShell PTY Always yes controller", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    sessionStorage.clear();
    sendRawSpy.mockReset();
    const autoYesKey = ptyAutoYesSessionKey("proxy-1", "s1");
    if (!autoYesKey) throw new Error("missing auto yes key");
    useAppStore.setState({
      connected: true,
      proxyOnline: true,
      selectedProxyId: "proxy-1",
      selectedProxyName: "Local Mac",
      proxies: [],
      proxyListLoaded: true,
      pendingToast: null,
      relayClientAuthIssue: null,
    });
    useSessionStore.setState({
      sessions: [makePtySession("s1"), makePtySession("s2")],
      sessionListLoaded: true,
      ptyStateBySessionId: {},
      agentStatusBySessionId: {},
      ptyAutoYesBySessionKey: { [autoYesKey]: true },
    });
  });

  it("continues auto-entering enabled PTY approvals after navigating away from that session", async () => {
    const router = renderAppShell("/chat/s1?mode=pty");

    await router.navigate("/chat/s2?mode=pty");
    setSessionState("s1", "waiting_approval");
    useSessionStore.getState().setPtyState("s1", {
      state: "approval_wait",
      seq: 1,
      tool: "Write",
    });

    await waitFor(() => expect(sendRawSpy).toHaveBeenCalledWith("s1", "\r"));
  });

  it("does not inherit PTY auto-enter in another session", async () => {
    renderAppShell("/chat/s1?mode=pty");

    setSessionState("s2", "waiting_approval");
    useSessionStore.getState().setPtyState("s2", {
      state: "approval_wait",
      seq: 1,
      tool: "Write",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendRawSpy).not.toHaveBeenCalled();
  });

  it("does not inherit PTY auto-enter in another proxy scope", async () => {
    renderAppShell("/chat/s1?mode=pty");

    useAppStore.setState({
      selectedProxyId: "proxy-2",
      selectedProxyName: "Other Mac",
    });
    setSessionState("s1", "waiting_approval");
    useSessionStore.getState().setPtyState("s1", {
      state: "approval_wait",
      seq: 1,
      tool: "Write",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendRawSpy).not.toHaveBeenCalled();
  });

  it("does not auto-enter stale PTY approval state after the server marks the session idle", async () => {
    renderAppShell("/chat/s2?mode=pty");

    useSessionStore.getState().setPtyState("s1", {
      state: "approval_wait",
      seq: 1,
      tool: "Write",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendRawSpy).not.toHaveBeenCalled();
  });
});
