import { describe, expect, it, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import {
  applyPtyStateToSession,
  type PtySessionBridgeDeps,
} from "#src/serve/pty-session-bridge.js";
import type { SessionInfo } from "#src/serve/session-manager.js";

function makeSession(state: SessionState): SessionInfo {
  return {
    id: "test-session",
    mode: "pty",
    provider: "claude",
    state,
    cwd: "/tmp",
    createdAt: 0,
    updatedAt: 0,
    pid: 0,
  };
}

function makeDeps(overrides?: Partial<PtySessionBridgeDeps>): PtySessionBridgeDeps & {
  changeSessionState: ReturnType<typeof vi.fn>;
  resolveInterruptedApprovals: ReturnType<typeof vi.fn>;
  emitAgentStatus: ReturnType<typeof vi.fn>;
} {
  return {
    changeSessionState: vi.fn().mockReturnValue(true),
    getSession: vi.fn(),
    getPendingApprovalCount: vi.fn().mockReturnValue(0),
    resolveInterruptedApprovals: vi.fn(),
    emitAgentStatus: vi.fn(),
    ...overrides,
  } as never;
}

describe("applyPtyStateToSession", () => {
  describe("approval_wait", () => {
    it("推 SessionState.WAITING_APPROVAL", () => {
      const deps = makeDeps();
      applyPtyStateToSession(deps, "s1", "approval_wait");
      expect(deps.changeSessionState).toHaveBeenCalledWith("s1", SessionState.WAITING_APPROVAL);
      expect(deps.resolveInterruptedApprovals).not.toHaveBeenCalled();
      expect(deps.emitAgentStatus).not.toHaveBeenCalled();
    });
  });

  describe("working", () => {
    it("IDLE session + 0 pending → 推 WORKING", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(makeSession(SessionState.IDLE)),
      });
      applyPtyStateToSession(deps, "s1", "working");
      expect(deps.changeSessionState).toHaveBeenCalledWith("s1", SessionState.WORKING);
    });

    it("WAITING_APPROVAL session + 0 pending → 推 WORKING（释放路径）", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(makeSession(SessionState.WAITING_APPROVAL)),
      });
      applyPtyStateToSession(deps, "s1", "working");
      expect(deps.changeSessionState).toHaveBeenCalledWith("s1", SessionState.WORKING);
    });

    it("WAITING_APPROVAL session + pending>0 → guard 拦截，不推", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(makeSession(SessionState.WAITING_APPROVAL)),
        getPendingApprovalCount: vi.fn().mockReturnValue(1),
      });
      applyPtyStateToSession(deps, "s1", "working");
      expect(deps.changeSessionState).not.toHaveBeenCalled();
    });

    it("WORKING session → guard 拦截（已经在 WORKING）", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(makeSession(SessionState.WORKING)),
      });
      applyPtyStateToSession(deps, "s1", "working");
      expect(deps.changeSessionState).not.toHaveBeenCalled();
    });

    it("TERMINATED / ERROR session → guard 拦截", () => {
      for (const state of [SessionState.TERMINATED, SessionState.ERROR]) {
        const deps = makeDeps({
          getSession: vi.fn().mockReturnValue(makeSession(state)),
        });
        applyPtyStateToSession(deps, "s1", "working");
        expect(deps.changeSessionState).not.toHaveBeenCalled();
      }
    });

    it("session 不存在 → 不推", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(undefined),
      });
      applyPtyStateToSession(deps, "s1", "working");
      expect(deps.changeSessionState).not.toHaveBeenCalled();
    });
  });

  describe("turn_complete", () => {
    it("WORKING session → resolveInterruptedApprovals + 推 IDLE + emit idle", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(makeSession(SessionState.WORKING)),
      });
      applyPtyStateToSession(deps, "s1", "turn_complete");
      expect(deps.resolveInterruptedApprovals).toHaveBeenCalledWith("s1");
      expect(deps.changeSessionState).toHaveBeenCalledWith("s1", SessionState.IDLE);
      expect(deps.emitAgentStatus).toHaveBeenCalledWith("s1", "idle");
    });

    it("WAITING_APPROVAL session → 推 IDLE（codex 取消审批 + claude OSC9 释放共用路径）", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(makeSession(SessionState.WAITING_APPROVAL)),
      });
      applyPtyStateToSession(deps, "s1", "turn_complete");
      expect(deps.changeSessionState).toHaveBeenCalledWith("s1", SessionState.IDLE);
    });

    it("IDLE session → 不重复推 IDLE，但仍清理 + emit idle", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(makeSession(SessionState.IDLE)),
      });
      applyPtyStateToSession(deps, "s1", "turn_complete");
      expect(deps.changeSessionState).not.toHaveBeenCalled();
      expect(deps.resolveInterruptedApprovals).toHaveBeenCalled();
      expect(deps.emitAgentStatus).toHaveBeenCalledWith("s1", "idle");
    });

    it("TERMINATED session → 不推 IDLE，但仍清理 + emit idle", () => {
      const deps = makeDeps({
        getSession: vi.fn().mockReturnValue(makeSession(SessionState.TERMINATED)),
      });
      applyPtyStateToSession(deps, "s1", "turn_complete");
      expect(deps.changeSessionState).not.toHaveBeenCalled();
    });
  });
});
