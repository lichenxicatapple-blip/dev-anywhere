import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusPayload, SessionInfo } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";
import { PtyAutoYesController } from "./pty-auto-yes-controller";

const sessionId = "s1";
const proxyId = "proxy-1";
const autoYesKey = ptyAutoYesSessionKey(proxyId, sessionId)!;

function makeSession(
  provider: "claude" | "codex" | "kimi" = "claude",
): Extract<SessionInfo, { kind: "agent"; mode: "pty" }> {
  return {
    sessionId,
    kind: "agent",
    mode: "pty",
    provider,
    ptyOwner: "local-terminal",
    cwd: "/tmp/project",
    state: "waiting_approval",
    lastActive: 1,
  };
}

function permission(
  requestId: string,
  provider: "claude" | "codex" = "claude",
  seq = 1,
): AgentStatusPayload {
  return {
    provider,
    phase: "waiting_permission",
    seq,
    updatedAt: seq,
    permissionRequest: { requestId, toolName: "Write", input: {} },
  };
}

function setSessionState(state: SessionInfo["state"]): void {
  act(() =>
    useSessionStore.setState({
      sessions: useSessionStore.getState().sessions.map((session) => ({ ...session, state })),
    }),
  );
}

function setPermission(requestId: string, provider: "claude" | "codex" = "claude", seq = 1): void {
  act(() =>
    useSessionStore.getState().setAgentStatus(sessionId, permission(requestId, provider, seq)),
  );
}

describe("PtyAutoYesController", () => {
  beforeEach(() => {
    useAppStore.setState({ connected: true, proxyOnline: true, selectedProxyId: proxyId });
    useSessionStore.setState({
      sessions: [makeSession()],
      ptyAutoYesBySessionKey: { [autoYesKey]: true },
      ptyStateBySessionId: { [sessionId]: { state: "approval_wait", seq: 1 } },
      agentStatusBySessionId: {},
    });
  });
  afterEach(cleanup);

  it.each(["local-terminal", "proxy-hosted"] as const)(
    "never injects automatic Enter into %s Codex PTYs, including persisted Always yes settings",
    (ptyOwner) => {
      useSessionStore.setState({ sessions: [{ ...makeSession("codex"), ptyOwner }] });
      const sendRawInput = vi.fn();
      render(<PtyAutoYesController sendRawInput={sendRawInput} />);
      for (const seq of [2, 3, 4]) {
        act(() =>
          useSessionStore.getState().setPtyState(sessionId, {
            state: "approval_wait",
            title: "Action Required",
            seq,
          }),
        );
        setSessionState("waiting_approval");
        setPermission(`req-${seq}`, "codex", seq);
      }
      setSessionState("idle");
      setSessionState("working");
      expect(sendRawInput).not.toHaveBeenCalled();
    },
  );

  it("confirms one non-Codex waiting window once despite repeated approval output sequences", () => {
    const sendRawInput = vi.fn();
    render(<PtyAutoYesController sendRawInput={sendRawInput} />);
    for (const seq of [2, 3]) {
      act(() => useSessionStore.getState().setPtyState(sessionId, { state: "approval_wait", seq }));
      setSessionState("waiting_approval");
    }
    expect(sendRawInput).toHaveBeenCalledExactlyOnceWith(sessionId, "\r");
  });

  it("does not revive stale PTY approval after idle or resumed work, but confirms a new waiting window", () => {
    const sendRawInput = vi.fn();
    render(<PtyAutoYesController sendRawInput={sendRawInput} />);
    setSessionState("idle");
    setSessionState("working");
    expect(useSessionStore.getState().ptyStateBySessionId[sessionId]?.state).toBe("approval_wait");
    expect(sendRawInput).toHaveBeenCalledTimes(1);
    setSessionState("waiting_approval");
    expect(sendRawInput).toHaveBeenCalledTimes(2);
  });

  it.each(["idle", "working"] as const)(
    "does not approve a retained PTY observation when first attached to a %s session",
    (state) => {
      setSessionState(state);
      const sendRawInput = vi.fn();
      render(<PtyAutoYesController sendRawInput={sendRawInput} />);
      expect(sendRawInput).not.toHaveBeenCalled();
    },
  );

  it("supports session_status arriving before PTY state or the request identity without double-confirming", () => {
    useSessionStore.setState({ ptyStateBySessionId: {} });
    const sendRawInput = vi.fn();
    render(<PtyAutoYesController sendRawInput={sendRawInput} />);
    act(() =>
      useSessionStore.getState().setPtyState(sessionId, { state: "approval_wait", seq: 1 }),
    );
    setPermission("req-1");
    expect(sendRawInput).toHaveBeenCalledTimes(1);
    setPermission("req-2", "claude", 2);
    expect(sendRawInput).toHaveBeenCalledTimes(2);
  });

  it("keeps confirmed request identities after idle and ignores replayed requests", () => {
    useSessionStore.setState({ agentStatusBySessionId: { [sessionId]: permission("req-1") } });
    const sendRawInput = vi.fn();
    render(<PtyAutoYesController sendRawInput={sendRawInput} />);
    setSessionState("idle");
    setSessionState("working");
    setPermission("req-1", "claude", 2);
    expect(sendRawInput).toHaveBeenCalledTimes(1);
    setPermission("req-2", "claude", 3);
    expect(sendRawInput).toHaveBeenCalledTimes(2);
  });

  it("waits for connectivity and preserves confirmation through disconnect and proxy-offline transitions", () => {
    useAppStore.setState({ connected: false });
    const sendRawInput = vi.fn();
    render(<PtyAutoYesController sendRawInput={sendRawInput} />);
    expect(sendRawInput).not.toHaveBeenCalled();
    act(() => useAppStore.setState({ connected: true }));
    act(() => useAppStore.setState({ connected: false }));
    act(() => useAppStore.setState({ connected: true, proxyOnline: false }));
    act(() => useAppStore.setState({ proxyOnline: true }));
    expect(sendRawInput).toHaveBeenCalledTimes(1);
  });

  it("confirms when Always yes is enabled during a wait, without repeating after toggling it", () => {
    useSessionStore.setState({ ptyAutoYesBySessionKey: {} });
    const sendRawInput = vi.fn();
    render(<PtyAutoYesController sendRawInput={sendRawInput} />);
    expect(sendRawInput).not.toHaveBeenCalled();
    act(() => useSessionStore.getState().setPtyAutoYes(autoYesKey, true));
    act(() => useSessionStore.getState().setPtyAutoYes(autoYesKey, false));
    act(() => useSessionStore.getState().setPtyAutoYes(autoYesKey, true));
    expect(sendRawInput).toHaveBeenCalledTimes(1);
  });

  it("keeps confirmation when session-list or proxy selection transitions remount a controller", () => {
    const sendRawInput = vi.fn();
    render(<PtyAutoYesController sendRawInput={sendRawInput} />);
    const sessions = useSessionStore.getState().sessions;
    act(() => useSessionStore.setState({ sessions: [] }));
    act(() => useSessionStore.setState({ sessions }));
    act(() => useAppStore.setState({ selectedProxyId: null }));
    act(() => useAppStore.setState({ selectedProxyId: proxyId }));
    expect(sendRawInput).toHaveBeenCalledTimes(1);
  });
});
