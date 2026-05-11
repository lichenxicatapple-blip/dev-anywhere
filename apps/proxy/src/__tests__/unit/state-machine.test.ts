import { describe, it, expect, vi } from "vitest";
import { createFSM, defineFSM } from "@dev-anywhere/shared";

// 测试用的小状态集：start → middle → end
const TRANSITIONS = {
  start: ["middle", "end"],
  middle: ["end"],
  end: [],
} as const;

type S = keyof typeof TRANSITIONS;

describe("createFSM", () => {
  it("初始状态 = initial", () => {
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS });
    expect(fsm.current()).toBe("start");
    expect(fsm.is("start")).toBe(true);
    expect(fsm.is("middle")).toBe(false);
  });

  it("合法转换更新 current()", () => {
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS });
    fsm.transitionTo("middle");
    expect(fsm.current()).toBe("middle");
    fsm.transitionTo("end");
    expect(fsm.current()).toBe("end");
  });

  it("非法转换抛 Error 且状态不变", () => {
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS });
    expect(() => fsm.transitionTo("start")).toThrow(/Invalid FSM transition: start -> start/);
    expect(fsm.current()).toBe("start");
  });

  it("终态（空 transitions）任何转换都抛", () => {
    const fsm = createFSM<S>({ initial: "end", transitions: TRANSITIONS });
    expect(() => fsm.transitionTo("start")).toThrow(/Invalid FSM transition: end -> start/);
    expect(() => fsm.transitionTo("end")).toThrow(/Invalid FSM transition: end -> end/);
  });

  it("onTransition 合法转换后被调用 (from, to)", () => {
    const onTransition = vi.fn();
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS, onTransition });
    fsm.transitionTo("middle");
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition).toHaveBeenCalledWith("start", "middle");
    fsm.transitionTo("end");
    expect(onTransition).toHaveBeenCalledTimes(2);
    expect(onTransition).toHaveBeenNthCalledWith(2, "middle", "end");
  });

  it("onTransition 非法转换时不触发", () => {
    const onTransition = vi.fn();
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS, onTransition });
    expect(() => fsm.transitionTo("start")).toThrow();
    expect(onTransition).not.toHaveBeenCalled();
  });

  it("onTransition 可选", () => {
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS });
    expect(() => fsm.transitionTo("middle")).not.toThrow();
    expect(fsm.current()).toBe("middle");
  });

  it("isIn 反映当前状态是否在集合内", () => {
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS });
    expect(fsm.isIn(["start", "middle"])).toBe(true);
    expect(fsm.isIn(["middle", "end"])).toBe(false);
    fsm.transitionTo("middle");
    expect(fsm.isIn(["middle", "end"])).toBe(true);
  });

  it("canTransitionTo 反映转换表", () => {
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS });
    expect(fsm.canTransitionTo("middle")).toBe(true);
    expect(fsm.canTransitionTo("end")).toBe(true);
    expect(fsm.canTransitionTo("start")).toBe(false);
    fsm.transitionTo("end");
    expect(fsm.canTransitionTo("start")).toBe(false);
    expect(fsm.canTransitionTo("end")).toBe(false);
  });

  it("tryTransitionTo 合法转换返回 true 并更新 current", () => {
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS });
    expect(fsm.tryTransitionTo("middle")).toBe(true);
    expect(fsm.current()).toBe("middle");
  });

  it("tryTransitionTo 非法转换返回 false 且状态不变，不抛", () => {
    const fsm = createFSM<S>({ initial: "start", transitions: TRANSITIONS });
    expect(() => fsm.tryTransitionTo("start")).not.toThrow();
    expect(fsm.tryTransitionTo("start")).toBe(false);
    expect(fsm.current()).toBe("start");
  });

  // 接近真实用例的图：active ↔ idle 循环，error 只能通向 terminated
  // idle/active 都有非吸收出边（互相循环）→ 都非吸收；error → [terminated] → 吸收
  const LIFECYCLE = {
    active: ["idle", "terminated"],
    idle: ["active", "terminated"],
    error: ["terminated"],
    terminated: [],
  } as const;
  type L = keyof typeof LIFECYCLE;

  it("isInAbsorbingState: 结构终态 (terminated)", () => {
    const fsm = createFSM<L>({ initial: "terminated", transitions: LIFECYCLE });
    expect(fsm.isInAbsorbingState()).toBe(true);
  });

  it("isInAbsorbingState: 闭包传递 (error → [terminated])", () => {
    const fsm = createFSM<L>({ initial: "error", transitions: LIFECYCLE });
    expect(fsm.isInAbsorbingState()).toBe(true);
  });

  it("isInAbsorbingState: 有非吸收出边的状态 (active/idle 互循环) 非吸收", () => {
    const a = createFSM<L>({ initial: "active", transitions: LIFECYCLE });
    expect(a.isInAbsorbingState()).toBe(false);
    const i = createFSM<L>({ initial: "idle", transitions: LIFECYCLE });
    expect(i.isInAbsorbingState()).toBe(false);
  });
});

describe("defineFSM.isAbsorbing", () => {
  const LIFECYCLE = {
    active: ["idle", "terminated"],
    idle: ["active", "terminated"],
    error: ["terminated"],
    terminated: [],
  } as const;
  type L = keyof typeof LIFECYCLE;

  it("终态被识别", () => {
    const fsm = defineFSM<L>(LIFECYCLE);
    expect(fsm.isAbsorbing("terminated")).toBe(true);
  });

  it("闭包传递: error 所有出边指向吸收 → 吸收", () => {
    const fsm = defineFSM<L>(LIFECYCLE);
    expect(fsm.isAbsorbing("error")).toBe(true);
  });

  it("active/idle 有非吸收出边 (互相循环) → 非吸收", () => {
    const fsm = defineFSM<L>(LIFECYCLE);
    expect(fsm.isAbsorbing("active")).toBe(false);
    expect(fsm.isAbsorbing("idle")).toBe(false);
  });

  it("互相循环的非终态不被判吸收", () => {
    const cyclic = { a: ["b"], b: ["a"] } as const;
    const fsm = defineFSM<"a" | "b">(cyclic);
    expect(fsm.isAbsorbing("a")).toBe(false);
    expect(fsm.isAbsorbing("b")).toBe(false);
  });
});
