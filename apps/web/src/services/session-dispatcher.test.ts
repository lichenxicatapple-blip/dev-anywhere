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
): MessageEnvelope {
  return {
    type,
    ...(type === "session_status" ? { sessionId: String(payload.sessionId) } : {}),
    payload,
    seq: 1,
    timestamp: 1,
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
});
