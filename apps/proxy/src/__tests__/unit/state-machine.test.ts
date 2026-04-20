import { describe, it, expect, vi } from "vitest";
import { createFSM } from "../../common/state-machine.js";

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
});
