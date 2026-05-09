// Claude 正在思考的三点跳动, 参考 Feishu 实现
// 挂载条件由上层控制: isWorking=true 且最后一条消息不是 assistant partial
// (否则与 message-bubble 内的流式光标信息冗余)
export function ThinkingIndicator() {
  return (
    <div
      className="flex justify-start px-4 py-2 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
      data-slot="thinking-indicator"
      role="status"
      aria-label="Claude 正在思考"
    >
      <div className="flex w-fit items-center gap-1.5 rounded-[8px_24px_24px_24px] bg-foreground/8 px-5 py-3">
        <span className="dev-thinking-dot" />
        <span className="dev-thinking-dot" />
        <span className="dev-thinking-dot" />
      </div>
    </div>
  );
}
