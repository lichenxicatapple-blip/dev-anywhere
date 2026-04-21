import { SessionState } from "@cc-anywhere/shared";

// OSC 派生的 PTY 语义信号 → SessionState 映射。
// mid_pause 故意不在表里：它是 spinner/标题刷新的心跳信号，不是状态转换。
const PTY_STATE_TO_SESSION: Record<string, SessionState> = {
  working: SessionState.WORKING,
  turn_complete: SessionState.IDLE,
  approval_wait: SessionState.WAITING_APPROVAL,
};

interface PtyObserverDeps {
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
}

// PTY 观察通道：把 terminal.ts 上报的 PTY 语义信号翻译成 SessionState。
// 观察通道天然没有 ERROR——PTY 错误体现为终端 ANSI 内容，proxy 不建模观察器失联。
export class PtyObserver {
  constructor(private deps: PtyObserverDeps) {}

  // pty_state_push IPC 到达时调用；未知/心跳信号（含 mid_pause）被静默忽略
  onPtySignal(sessionId: string, ptyState: string): void {
    const next = PTY_STATE_TO_SESSION[ptyState];
    if (next === undefined) return;
    this.deps.changeSessionState(sessionId, next);
  }

  // terminal 进程首次注册或重连：观察零点视作 IDLE，后续 pty_state_push 自然推进
  onTerminalAttached(sessionId: string): void {
    this.deps.changeSessionState(sessionId, SessionState.IDLE);
  }
}
