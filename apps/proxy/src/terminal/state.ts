import type { Socket } from "node:net";
import { createFSM } from "../common/state-machine.js";
import { serializeIpc } from "../ipc/ipc-protocol.js";

// terminal 进程生命周期状态
export const TerminalState = {
  INIT: "init",
  CONNECTING_SERVICE: "connecting_service",
  CREATING_SESSION: "creating_session",
  RUNNING: "running",
  RECONNECTING: "reconnecting",
  EXITED: "exited",
} as const;
export type TerminalState = (typeof TerminalState)[keyof typeof TerminalState];

// 允许的状态转换。CREATING_SESSION/RUNNING 下可被 socket close 打断进入 RECONNECTING；
// 任意非终态都可能被 PTY 退出或 SIGTERM 打断进入 EXITED。
export const TERMINAL_TRANSITIONS: Record<TerminalState, readonly TerminalState[]> = {
  init: ["connecting_service"],
  connecting_service: ["creating_session", "exited"],
  creating_session: ["running", "reconnecting", "exited"],
  running: ["reconnecting", "exited"],
  reconnecting: ["creating_session", "running", "exited"],
  exited: [],
};

// 下面几个依赖是 getter 而非值：因为它们在 terminal.ts 里是 let 变量，在 handler 创建之后还会变——
// socket 在 reconnect 时被重新赋值为新实例，sessionId 在 session_create 成功后才有值，
// idleChecker 在 setupIdleCheck 跑完才赋值。直接传值只会记录 handler 构造那一刻的旧值。
interface ExitHandlerDeps {
  fsm: ReturnType<typeof createFSM<TerminalState>>;
  getSocket: () => Socket;
  getSessionId: () => string | null;
  // 退出时要停掉的 idle checker；handler 创建时尚未实例化，故传 getter
  stopIdleChecker: () => void;
  // 测试注入点，production 默认 process.exit
  exit?: (code: number) => void;
}

// 构造统一的收尾函数：转 EXITED → 停 idle 定时器 → 给 serve 发 pty_deregister → 退进程。
// onSessionExit 与 SIGTERM handler 共享同一实例；Ctrl+C 两连击或 PTY 退出与 SIGTERM 竞争时，
// 第二次调用通过 fsm EXITED 检查直接短路。
export function createExitHandler(deps: ExitHandlerDeps): (code: number) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  return (code: number) => {
    if (deps.fsm.is(TerminalState.EXITED)) return;
    deps.fsm.transitionTo(TerminalState.EXITED);
    deps.stopIdleChecker();
    const socket = deps.getSocket();
    const sessionId = deps.getSessionId();
    if (socket.writable && sessionId) {
      socket.end(serializeIpc({ type: "pty_deregister", sessionId }), () => exit(code));
    } else {
      exit(code);
    }
  };
}
