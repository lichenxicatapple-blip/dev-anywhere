import { describe, it, expect } from "vitest";
import { decidePtySemanticTransition } from "#src/common/pty-semantic-machine.js";

// 状态机契约：六条规则的边界与组合
// 规则 1: signal=approval_wait → approval_wait, emit=true
// 规则 2: currentState=approval_wait + signal!=approval_wait → stateAfterApprovalRelease, emit=true
// 规则 3: 审批上下文 + signal!=turn_complete → 维持 approval_wait, emit=true
// 规则 4: signal!=working → signal.state, emit=true
// 规则 5: currentState!=working + 无 signal → working, emit=true
// 规则 6: currentState=working + 无信号 → 不变，emit=false

describe("decidePtySemanticTransition", () => {
  describe("规则 1: 进入审批", () => {
    it("从 working 收到 approval_wait → approval_wait", () => {
      const r = decidePtySemanticTransition({
        currentState: "working",
        signal: { state: "approval_wait", tool: "Bash" },
      });
      expect(r).toEqual({
        nextState: "approval_wait",
        emit: true,
        meta: { tool: "Bash" },
      });
    });

    it("已在 approval_wait 时再次收到 approval_wait → 仍然 approval_wait（meta 更新）", () => {
      const r = decidePtySemanticTransition({
        currentState: "approval_wait",
        signal: { state: "approval_wait", tool: "Edit" },
      });
      expect(r.nextState).toBe("approval_wait");
      expect(r.emit).toBe(true);
      expect(r.meta).toEqual({ tool: "Edit" });
    });
  });

  describe("规则 2: 审批解除", () => {
    it("approval_wait + signal=working → working", () => {
      const r = decidePtySemanticTransition({
        currentState: "approval_wait",
        signal: { state: "working" },
      });
      expect(r).toEqual({ nextState: "working", emit: true, meta: {} });
    });

    it("approval_wait + signal=turn_complete → turn_complete", () => {
      const r = decidePtySemanticTransition({
        currentState: "approval_wait",
        signal: { state: "turn_complete" },
      });
      expect(r.nextState).toBe("turn_complete");
      expect(r.emit).toBe(true);
    });

    it("approval_wait + signal=mid_pause → mid_pause", () => {
      const r = decidePtySemanticTransition({
        currentState: "approval_wait",
        signal: { state: "mid_pause" },
      });
      expect(r.nextState).toBe("mid_pause");
      expect(r.emit).toBe(true);
    });
  });

  describe("规则 3: 审批上下文兜底", () => {
    it("currentState=approval_wait 但本帧无 signal → 维持 approval_wait", () => {
      const r = decidePtySemanticTransition({
        currentState: "approval_wait",
        signal: null,
      });
      expect(r.nextState).toBe("approval_wait");
      expect(r.emit).toBe(true);
    });

    it("hosted-pty 场景：local working 但 sessionState=WAITING_APPROVAL → approval_wait", () => {
      const r = decidePtySemanticTransition({
        currentState: "working",
        signal: { state: "working" },
        sessionStateIsWaitingApproval: true,
      });
      expect(r.nextState).toBe("approval_wait");
      expect(r.emit).toBe(true);
    });

    it("sessionStateIsWaitingApproval 但收到 turn_complete → 仍走规则 2 解除审批", () => {
      const r = decidePtySemanticTransition({
        currentState: "approval_wait",
        signal: { state: "turn_complete" },
        sessionStateIsWaitingApproval: true,
      });
      expect(r.nextState).toBe("turn_complete");
    });
  });

  describe("规则 4: 非 working 信号", () => {
    it("working + signal=turn_complete → turn_complete", () => {
      const r = decidePtySemanticTransition({
        currentState: "working",
        signal: { state: "turn_complete" },
      });
      expect(r.nextState).toBe("turn_complete");
      expect(r.emit).toBe(true);
    });

    it("turn_complete + signal=mid_pause → mid_pause", () => {
      const r = decidePtySemanticTransition({
        currentState: "turn_complete",
        signal: { state: "mid_pause" },
      });
      expect(r.nextState).toBe("mid_pause");
      expect(r.emit).toBe(true);
    });
  });

  describe("规则 5: 隐式回到 working", () => {
    it("turn_complete + 无 signal → working", () => {
      const r = decidePtySemanticTransition({
        currentState: "turn_complete",
        signal: null,
      });
      expect(r.nextState).toBe("working");
      expect(r.emit).toBe(true);
    });

    it("mid_pause + signal=working → working", () => {
      const r = decidePtySemanticTransition({
        currentState: "mid_pause",
        signal: { state: "working" },
      });
      expect(r.nextState).toBe("working");
      expect(r.emit).toBe(true);
    });
  });

  describe("规则 6: 稳态无变化", () => {
    it("working + 无 signal → 不 emit", () => {
      const r = decidePtySemanticTransition({
        currentState: "working",
        signal: null,
      });
      expect(r).toEqual({ nextState: "working", emit: false });
    });

    it("working + signal=working → 不 emit", () => {
      const r = decidePtySemanticTransition({
        currentState: "working",
        signal: { state: "working" },
      });
      expect(r.nextState).toBe("working");
      expect(r.emit).toBe(false);
    });
  });

  describe("meta 透传", () => {
    it("title + tool 全部透传", () => {
      const r = decidePtySemanticTransition({
        currentState: "working",
        signal: { state: "approval_wait", title: "需要审批", tool: "Bash" },
      });
      expect(r.meta).toEqual({ title: "需要审批", tool: "Bash" });
    });

    it("仅 tool 时不挂 undefined title", () => {
      const r = decidePtySemanticTransition({
        currentState: "working",
        signal: { state: "approval_wait", tool: "Read" },
      });
      expect(r.meta).toEqual({ tool: "Read" });
      expect("title" in (r.meta ?? {})).toBe(false);
    });
  });
});
