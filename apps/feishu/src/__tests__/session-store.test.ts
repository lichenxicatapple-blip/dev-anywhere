import { describe, it, expect } from "vitest";
import { sessionReducer, initialSessionState } from "@/stores/session-store";
import type { SessionStoreState } from "@/stores/session-store";

function stateWithSessions(): SessionStoreState {
  return {
    ...initialSessionState,
    sessions: [
      { sessionId: "s1", name: "Session 1", state: "idle", mode: "pty" },
      { sessionId: "s2", name: "Session 2", state: "working", mode: "json" },
    ],
  };
}

describe("sessionReducer", () => {
  describe("UPDATE_SESSION_NAME", () => {
    it("updates name of matching session", () => {
      const state = stateWithSessions();
      const next = sessionReducer(state, {
        type: "UPDATE_SESSION_NAME",
        sessionId: "s1",
        name: "Working: fix auth bug",
      });
      expect(next.sessions[0].name).toBe("Working: fix auth bug");
      expect(next.sessions[1].name).toBe("Session 2");
    });

    it("does not modify state when sessionId not found", () => {
      const state = stateWithSessions();
      const next = sessionReducer(state, {
        type: "UPDATE_SESSION_NAME",
        sessionId: "nonexistent",
        name: "New Name",
      });
      expect(next.sessions).toEqual(state.sessions);
    });
  });

  describe("UPDATE_SESSION_STATE", () => {
    it("updates state of matching session", () => {
      const state = stateWithSessions();
      const next = sessionReducer(state, {
        type: "UPDATE_SESSION_STATE",
        sessionId: "s2",
        state: "idle",
      });
      expect(next.sessions[1].state).toBe("idle");
      expect(next.sessions[0].state).toBe("idle");
    });
  });

  describe("REMOVE_SESSION", () => {
    it("removes session and clears currentSessionId if matched", () => {
      const state = { ...stateWithSessions(), currentSessionId: "s1", currentSessionMode: "pty" as const };
      const next = sessionReducer(state, { type: "REMOVE_SESSION", sessionId: "s1" });
      expect(next.sessions).toHaveLength(1);
      expect(next.sessions[0].sessionId).toBe("s2");
      expect(next.currentSessionId).toBeNull();
    });

    it("keeps currentSessionId if different session removed", () => {
      const state = { ...stateWithSessions(), currentSessionId: "s1", currentSessionMode: "pty" as const };
      const next = sessionReducer(state, { type: "REMOVE_SESSION", sessionId: "s2" });
      expect(next.sessions).toHaveLength(1);
      expect(next.currentSessionId).toBe("s1");
    });
  });
});
