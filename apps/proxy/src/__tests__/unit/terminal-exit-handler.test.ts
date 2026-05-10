import { describe, it, expect, vi } from "vitest";
import { createFSM } from "../../common/state-machine.js";
import { createExitHandler, TerminalState, TERMINAL_TRANSITIONS } from "../../terminal/state.js";
import { createSocketFake } from "./test-fakes.js";

function makeFsm(initial: TerminalState = TerminalState.RUNNING) {
  return createFSM<TerminalState>({ initial, transitions: TERMINAL_TRANSITIONS });
}

function makeSocket(writable: boolean) {
  const end = vi.fn((_msg: string, cb: () => void) => {
    cb();
  });
  return createSocketFake({ writable, end });
}

describe("createExitHandler", () => {
  it("首次调用：fsm 转 EXITED + 停 idle checker + socket.end(pty_deregister) + exit(code)", () => {
    const fsm = makeFsm(TerminalState.RUNNING);
    const { socket, end } = makeSocket(true);
    const stopIdleChecker = vi.fn();
    const exit = vi.fn();

    const cleanup = createExitHandler({
      fsm,
      getSocket: () => socket,
      getSessionId: () => "sess-1",
      stopIdleChecker,
      exit,
    });

    cleanup(42);

    expect(fsm.current()).toBe(TerminalState.EXITED);
    expect(stopIdleChecker).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    const [msg] = end.mock.calls[0];
    expect(msg).toContain("pty_deregister");
    expect(msg).toContain("sess-1");
    expect(exit).toHaveBeenCalledWith(42);
  });

  it("二次调用：fsm 已 EXITED 直接短路，不重复 transition / end / exit", () => {
    const fsm = makeFsm(TerminalState.RUNNING);
    const { socket, end } = makeSocket(true);
    const exit = vi.fn();

    const cleanup = createExitHandler({
      fsm,
      getSocket: () => socket,
      getSessionId: () => "sess-1",
      stopIdleChecker: () => {},
      exit,
    });

    cleanup(0);
    cleanup(1); // 模拟 SIGTERM 在 onSessionExit 后又触发

    expect(fsm.current()).toBe(TerminalState.EXITED);
    expect(end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0); // 保留首次调用的 code
  });

  it("socket.writable=false：跳过 socket.end，直接 exit(code)", () => {
    const fsm = makeFsm(TerminalState.RUNNING);
    const { socket, end } = makeSocket(false);
    const exit = vi.fn();

    const cleanup = createExitHandler({
      fsm,
      getSocket: () => socket,
      getSessionId: () => "sess-1",
      stopIdleChecker: () => {},
      exit,
    });

    cleanup(7);

    expect(fsm.current()).toBe(TerminalState.EXITED);
    expect(end).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(7);
  });

  it("sessionId=null：跳过 socket.end，直接 exit(code)", () => {
    const fsm = makeFsm(TerminalState.CONNECTING_SERVICE);
    const { socket, end } = makeSocket(true);
    const exit = vi.fn();

    const cleanup = createExitHandler({
      fsm,
      getSocket: () => socket,
      getSessionId: () => null,
      stopIdleChecker: () => {},
      exit,
    });

    cleanup(143);

    expect(fsm.current()).toBe(TerminalState.EXITED);
    expect(end).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("getter 每次调用都读最新值（reconnect 中 socket 被重新赋值后仍生效）", () => {
    const fsm = makeFsm(TerminalState.RUNNING);
    let sessionId: string | null = null;
    const { socket, end } = makeSocket(true);
    const exit = vi.fn();

    const cleanup = createExitHandler({
      fsm,
      getSocket: () => socket,
      getSessionId: () => sessionId,
      stopIdleChecker: () => {},
      exit,
    });

    // handler 创建时 sessionId 为 null；创建后再赋值，调用时应读到新值
    sessionId = "sess-late";
    cleanup(0);

    expect(end).toHaveBeenCalledTimes(1);
    const [msg] = end.mock.calls[0];
    expect(msg).toContain("sess-late");
  });
});

describe("TERMINAL_TRANSITIONS", () => {
  it("允许 CREATING_SESSION → RECONNECTING（reconnect 期间 socket 再次断开）", () => {
    const fsm = createFSM<TerminalState>({
      initial: TerminalState.CREATING_SESSION,
      transitions: TERMINAL_TRANSITIONS,
    });
    expect(fsm.canTransitionTo(TerminalState.RECONNECTING)).toBe(true);
    fsm.transitionTo(TerminalState.RECONNECTING);
    expect(fsm.current()).toBe(TerminalState.RECONNECTING);
  });

  it("RECONNECTING 可直接转 RUNNING（无 sessionId 的回落分支）", () => {
    const fsm = createFSM<TerminalState>({
      initial: TerminalState.RECONNECTING,
      transitions: TERMINAL_TRANSITIONS,
    });
    expect(fsm.canTransitionTo(TerminalState.RUNNING)).toBe(true);
  });

  it("任意非 EXITED 状态都可转 EXITED（PTY 退出/SIGTERM 打断）", () => {
    for (const state of [
      TerminalState.CONNECTING_SERVICE,
      TerminalState.CREATING_SESSION,
      TerminalState.RUNNING,
      TerminalState.RECONNECTING,
    ]) {
      const fsm = createFSM<TerminalState>({
        initial: state,
        transitions: TERMINAL_TRANSITIONS,
      });
      expect(fsm.canTransitionTo(TerminalState.EXITED)).toBe(true);
    }
  });

  it("EXITED 是终态，任何转换都被拒", () => {
    const fsm = createFSM<TerminalState>({
      initial: TerminalState.EXITED,
      transitions: TERMINAL_TRANSITIONS,
    });
    expect(fsm.canTransitionTo(TerminalState.EXITED)).toBe(false);
    expect(fsm.canTransitionTo(TerminalState.RUNNING)).toBe(false);
  });

  it("INIT 只能转 CONNECTING_SERVICE", () => {
    const fsm = createFSM<TerminalState>({
      initial: TerminalState.INIT,
      transitions: TERMINAL_TRANSITIONS,
    });
    expect(fsm.canTransitionTo(TerminalState.CONNECTING_SERVICE)).toBe(true);
    expect(fsm.canTransitionTo(TerminalState.RUNNING)).toBe(false);
    expect(fsm.canTransitionTo(TerminalState.EXITED)).toBe(false); // 启动前不该 skip 到终态
  });
});
