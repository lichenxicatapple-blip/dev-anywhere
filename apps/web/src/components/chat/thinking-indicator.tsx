import type { ReactNode } from "react";

// Agent 正在思考的三点跳动。
// 只在当前 turn 没有 activity / assistant partial 可承载控制区时挂载。
export function ThinkingIndicator({ turnControl }: { turnControl?: ReactNode }) {
  return (
    <div
      className="dev-chat-rail-inset py-2 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
      data-slot="thinking-indicator"
      role="status"
      aria-label="Agent 正在思考"
    >
      <div className="dev-message-rail mx-auto flex w-full justify-start">
        <div className="flex w-fit items-center gap-2 rounded-[8px_24px_24px_24px] bg-foreground/8 px-4 py-2.5">
          <span className="flex items-center gap-1.5" aria-hidden="true">
            <span className="dev-thinking-dot" />
            <span className="dev-thinking-dot" />
            <span className="dev-thinking-dot" />
          </span>
          {turnControl ? (
            <span
              data-slot="thinking-turn-control"
              className="ml-1 flex items-center border-l border-foreground/10 pl-1"
            >
              {turnControl}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
