import { SessionState } from "@cc-anywhere/shared";

interface JsonObserverDeps {
  changeSessionState: (sessionId: string, next: SessionState) => boolean;
}

// JSON 观察通道：把 worker 转发的 stream-json 事件翻译成 SessionState。
// ERROR 态表达 "worker 进程活着，但 proxy 观察/控制通道已坏"（control_response 写入失败、
// stream 连续 parse 失败、未来可能的 heartbeat 超时等）；turn 内部的 is_error=true 不是观察失联，
// 不触发 ERROR，仍按 onTurnResult 回 IDLE 处理。
export class JsonObserver {
  constructor(private deps: JsonObserverDeps) {}

  // 用户消息注入 worker（relay-router 收到 user_input）→ 进入 WORKING
  onTurnStart(sessionId: string): void {
    this.deps.changeSessionState(sessionId, SessionState.WORKING);
  }

  // stream-json result event 到达 → turn 结束回 IDLE
  onTurnResult(sessionId: string): void {
    this.deps.changeSessionState(sessionId, SessionState.IDLE);
  }

  // control_request event 到达 → worker 阻塞等审批
  onApprovalRequested(sessionId: string): void {
    this.deps.changeSessionState(sessionId, SessionState.WAITING_APPROVAL);
  }

  // 观察通道失联 → ERROR，待人工干预或后续 terminate
  onChannelBroken(sessionId: string): void {
    this.deps.changeSessionState(sessionId, SessionState.ERROR);
  }
}
