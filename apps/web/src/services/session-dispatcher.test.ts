import { beforeEach, describe, expect, it } from "vitest";
import type { MessageEnvelope, SessionInfo } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { createSessionMessageHandler } from "./session-dispatcher";

function session(sessionId: string, state: SessionInfo["state"] = "idle"): SessionInfo {
  return { sessionId, state, provider: "claude", mode: "json" };
}

function envelope(
  type: "session_list" | "session_status",
  payload: Record<string, unknown>,
  timestamp = 1,
): MessageEnvelope {
  return {
    type,
    ...(type === "session_status" ? { sessionId: String(payload.sessionId) } : {}),
    payload,
    seq: 1,
    timestamp,
    source: "proxy",
    version: "1",
  } as MessageEnvelope;
}

describe("session-dispatcher lifecycle reconciliation", () => {
  beforeEach(() => {
    useAppStore.setState({ selectedProxyId: "proxy-1" });
    useSessionStore.setState({ sessions: [], sessionListLoaded: false });
    useChatStore.getState().clearAllSessions();
  });

  it("prunes chat slices that are absent from the authoritative session list", () => {
    useChatStore.getState().setInputDraft("alive", "keep");
    useChatStore.getState().setInputDraft("removed", "discard");

    createSessionMessageHandler()(envelope("session_list", { sessions: [session("alive")] }));

    expect(Object.keys(useChatStore.getState().bySessionId)).toEqual(["alive"]);
    expect(useChatStore.getState().bySessionId.alive.inputDraft).toBe("keep");
  });

  it("ignores an older empty list that arrives after a reconnected terminal list", () => {
    useChatStore.getState().setInputDraft("reconnected", "keep");
    const handler = createSessionMessageHandler();

    handler(envelope("session_list", { sessions: [session("reconnected")] }, 200));
    handler(envelope("session_list", { sessions: [] }, 100));

    expect(useSessionStore.getState().sessions.map((item) => item.sessionId)).toEqual([
      "reconnected",
    ]);
    expect(useChatStore.getState().bySessionId.reconnected.inputDraft).toBe("keep");
  });

  it("accepts an older clock after an explicit proxy switch reset", () => {
    const handler = createSessionMessageHandler();
    handler(envelope("session_list", { sessions: [session("old-binding")] }, 200));

    useSessionStore.getState().prepareForProxySwitch("Other proxy");
    useAppStore.setState({ selectedProxyId: "proxy-2" });
    handler(envelope("session_list", { sessions: [session("new-binding")] }, 10));

    expect(useSessionStore.getState().sessions.map((item) => item.sessionId)).toEqual([
      "new-binding",
    ]);
  });

  it("fails the active turn and clears approvals when the worker channel errors", () => {
    useSessionStore.setState({ sessions: [session("s1", "waiting_approval")] });
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "req-1",
      toolName: "Bash",
      input: { command: "pwd" },
      status: "pending",
    });

    createSessionMessageHandler()(
      envelope("session_status", { sessionId: "s1", state: "error", lastActive: 2 }),
    );

    expect(useSessionStore.getState().sessions[0].state).toBe("error");
    expect(useChatStore.getState().bySessionId.s1.pendingApprovals).toEqual([]);
  });

  it("leaves request-scoped history responses to the proxy-checked request owner", () => {
    useSessionStore.setState({
      historySessions: [
        {
          id: "current",
          title: "Current proxy",
          projectDir: "/current",
          updatedAt: 1,
          provider: "claude",
        },
      ],
    });

    createSessionMessageHandler()({
      type: "session_history_response",
      requestId: "history-old-proxy",
      success: true,
      sessions: [
        {
          id: "stale",
          title: "Old proxy",
          projectDir: "/old",
          updatedAt: 2,
          provider: "claude",
        },
      ],
    });

    expect(useSessionStore.getState().historySessions.map((item) => item.id)).toEqual(["current"]);
  });

  it("does not revive a timed-out history load when its late response arrives", () => {
    const current = {
      id: "current",
      title: "Last known history",
      projectDir: "/current",
      updatedAt: 1,
      provider: "claude" as const,
    };
    useSessionStore.setState({
      historySessions: [current],
      historyLoadStatus: "error",
      historyLoadGeneration: 7,
    });

    createSessionMessageHandler()({
      type: "session_history_response",
      requestId: "timed-out-request",
      success: true,
      sessions: [
        {
          id: "late",
          title: "Late response",
          projectDir: "/late",
          updatedAt: 2,
          provider: "claude",
        },
      ],
    });

    expect(useSessionStore.getState()).toMatchObject({
      historySessions: [current],
      historyLoadStatus: "error",
      historyLoadGeneration: 7,
    });
  });
});
