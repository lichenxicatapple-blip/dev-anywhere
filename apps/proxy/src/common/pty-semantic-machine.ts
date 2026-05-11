import type { PtySemanticState } from "@dev-anywhere/shared";
import { shouldReleaseApprovalWait, stateAfterApprovalRelease } from "./pty-approval-state.js";

// PTY 语义状态机的纯决策层。从一段 PTY 输出抽到的 OSC 信号 + 当前 PTY 局部状态出发，
// 决定下一态以及是否要 emit 一次 pty_state 事件。
// 副作用（changeSessionState、onTurnComplete、IPC 写）由调用方负责，本模块零 IO，便于单测。
//
// signal.state 三态：明确语义（working/turn_complete/approval_wait）、null（仅 OSC 0 title
// 更新无语义）、signal 整体为 null（本帧无 OSC）。title-only signal 在 approval_wait 上下文
// 下视为释放信号（codex 取消审批），其它上下文不参与 FSM 决策。

interface PtySignal {
  state: PtySemanticState | null;
  title?: string;
  tool?: string;
}

interface PtyTransitionInput {
  currentState: PtySemanticState;
  signal: PtySignal | null;
  // hosted-pty 在 JSON FSM 维度也维护 session.state；当外部 hook 已先把 session 推到
  // WAITING_APPROVAL 而本地 currentState 还停在 working 时，本帧仍应被解释为审批等待中。
  // terminal.ts 没有这个上下文，传 false / undefined 即可。
  sessionStateIsWaitingApproval?: boolean;
}

interface PtyTransitionResult {
  // 决策后应当采用的 currentState 值；与 input.currentState 相同表示局部状态不变。
  nextState: PtySemanticState;
  // 是否要把这次决策作为一次 pty_state 事件外发（含 hosted 端的 sessionFsm 副作用）。
  emit: boolean;
  // 透传给 emit 事件的 meta；emit=false 时忽略。
  meta?: { title?: string; tool?: string };
}

function withMeta(signal: PtySignal | null | undefined): { title?: string; tool?: string } {
  return {
    ...(signal?.title !== undefined ? { title: signal.title } : {}),
    ...(signal?.tool !== undefined ? { tool: signal.tool } : {}),
  };
}

export function decidePtySemanticTransition(input: PtyTransitionInput): PtyTransitionResult {
  const { currentState, signal, sessionStateIsWaitingApproval } = input;

  // 1. 显式 approval_wait 信号：进入 / 维持审批等待。
  if (signal?.state === "approval_wait") {
    return { nextState: "approval_wait", emit: true, meta: withMeta(signal) };
  }

  // 2. 已在 approval_wait 且收到非 approval_wait 信号（含 title-only）：审批解除，
  //    落到 stateAfterApprovalRelease 决定的状态上。
  if (
    shouldReleaseApprovalWait({
      currentState,
      signalState: signal === null ? undefined : signal.state,
    })
  ) {
    return {
      nextState: stateAfterApprovalRelease(signal!.state),
      emit: true,
      meta: withMeta(signal),
    };
  }

  // 3. 审批上下文兜底：currentState=approval_wait 或 sessionState 已是 WAITING_APPROVAL 但还没收到
  //    解除信号。此时即便有其它信号也不应让 PTY 状态偏离审批等待，仍 re-emit approval_wait。
  //    turn_complete 不在此列：它是合法的解除终点（由 #2 处理）。
  const inApprovalContext =
    currentState === "approval_wait" || sessionStateIsWaitingApproval === true;
  if (inApprovalContext && signal?.state !== "turn_complete") {
    return { nextState: "approval_wait", emit: true, meta: withMeta(signal) };
  }

  // 4. title-only signal（state=null，且不在审批上下文）：不参与 FSM 决策，title 由调用方
  //    单独经 sendTerminalTitle 推。这里 emit=false 避免 spam pty_state。
  if (signal !== null && signal.state === null) {
    return { nextState: currentState, emit: false };
  }

  // 5. 任意非 working 显式信号（turn_complete）：直接落到 signal.state。
  if (signal && signal.state !== null && signal.state !== "working") {
    return { nextState: signal.state, emit: true, meta: withMeta(signal) };
  }

  // 6. 隐式 working：当前不在 working 且本帧没有显式信号或信号 state=working，则推到 working。
  if (currentState !== "working") {
    return { nextState: "working", emit: true };
  }

  // 7. 无变化：current==working 且没有有效信号。不产生事件。
  return { nextState: currentState, emit: false };
}
