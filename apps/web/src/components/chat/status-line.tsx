// Chat panel 顶部 4px 状态色带，颜色+动画承载 5 态会话状态
// 聚合信号优先级：disconnected > waiting_approval > terminated > working > idle
import "./status-line.css";

export type StatusLineState =
  | "idle"
  | "working"
  | "waiting_approval"
  | "terminated"
  | "disconnected";

interface StatusLineProps {
  state: StatusLineState;
}

const ARIA_LABEL: Record<StatusLineState, string> = {
  idle: "会话空闲",
  working: "正在响应",
  waiting_approval: "等待工具审批",
  terminated: "会话已终止",
  disconnected: "连接已断开",
};

export function StatusLine({ state }: StatusLineProps) {
  return (
    <div
      className={`cc-status-line cc-status-line-${state}`}
      data-slot="status-line"
      data-state={state}
      role="status"
      aria-label={ARIA_LABEL[state]}
    >
      {state === "idle" && <div className="cc-status-line-sweep cc-status-line-sweep-idle" />}
      {state === "working" && <div className="cc-status-line-sweep cc-status-line-sweep-working" />}
      {state === "waiting_approval" && (
        <div className="cc-status-line-sweep cc-status-line-sweep-waiting" />
      )}
    </div>
  );
}
