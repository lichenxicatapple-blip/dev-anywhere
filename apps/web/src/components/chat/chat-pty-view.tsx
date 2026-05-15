// PTY 模式保留 provider 原生 TUI，Web 只负责滚动和输入转发。
// 浏览器滚动容器映射到 xterm viewportY；当真实 PTY 屏幕比 Web 可视区矮时，
// scroll spacer 仍保证底部位置能映射到 xterm baseY，而不是伪造额外终端行。
//
// 编排（4 个 controller 的生命周期 + 调度器 + debug 注册）全部下沉到 usePtyView，
// 本组件仅负责 DOM 结构与 JSX 接线。
import { useRef, useState } from "react";
import { formatPtyScrollTraceReport } from "@/lib/pty-scroll-trace";
import { BackToBottom } from "./back-to-bottom";
import { PtyConnectionOverlay } from "./pty-connection-overlay";
import { PtyMobileControls } from "./pty-mobile-controls";
import { PtyHorizontalScrollbar, PtyScrollbar } from "./pty-scrollbar";
import { usePtyView } from "./use-pty-view";

interface ChatPtyViewProps {
  sessionId: string;
  ptyOwner?: "local-terminal" | "proxy-hosted";
}

export function ChatPtyView({ sessionId, ptyOwner }: ChatPtyViewProps) {
  // containerEl 用 state 是为了让 scroll controller 在 DOM 挂载后初始化
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);

  const view = usePtyView({ sessionId, ptyOwner, containerEl, spacerRef, xtermHostRef });

  return (
    <div className="flex flex-col h-full relative" data-slot="chat-pty-view">
      <div
        ref={setContainerEl}
        className="flex-1 min-h-0 overflow-auto overscroll-contain bg-[#1E1E1E] px-3 pt-2"
        style={{
          paddingBottom: view.containerPaddingBottom,
          touchAction: "pan-x pan-y",
        }}
        onMouseDownCapture={view.handleTerminalContainerMouseDown}
        onPointerDownCapture={view.pointerHandlers.onPointerDownCapture}
        onPointerMoveCapture={view.pointerHandlers.onPointerMoveCapture}
        onPointerUpCapture={view.pointerHandlers.onPointerUpCapture}
        onPointerCancelCapture={view.pointerHandlers.onPointerCancelCapture}
        onPasteCapture={view.handlePasteCapture}
        onDragOver={view.handlePtyDragOver}
        onDragLeave={view.handlePtyDragLeave}
        onDrop={view.handlePtyDrop}
        onFocusCapture={view.focusHandlers.onFocusCapture}
        onBlurCapture={view.focusHandlers.onBlurCapture}
        data-slot="pty-terminal"
        data-drag-over={view.isPtyDragOver ? "true" : undefined}
      >
        <div ref={spacerRef} style={{ position: "relative" }} data-slot="pty-spacer">
          <div
            ref={xtermHostRef}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              overflow: "hidden",
              boxSizing: "border-box",
            }}
            data-slot="pty-host"
          />
        </div>
      </div>
      <BackToBottom
        visible={!view.isAtBottom}
        hasNewMessages={view.hasNewFramesWhileAway}
        className={
          view.showMobilePtyControls
            ? "right-6 bottom-[calc(env(safe-area-inset-bottom)+7rem)]"
            : view.touchEditingSurface
              ? "right-6"
              : "right-12"
        }
        onClick={() => {
          // 用户明示动作: 压过 intent (即便用户在回看, 点这个按钮就是要退出回看)。
          view.scrollToBottom("backToBottomBtn", { force: true });
          view.clearNewFramesWhileAway();
        }}
      />
      {view.showMobilePtyControls ? <PtyMobileControls onInput={view.sendMobileInput} /> : null}
      <PtyScrollbar state={view.scrollState} onScrollRatio={view.scrollToRatio} />
      <PtyHorizontalScrollbar state={view.scrollState} onScrollRatio={view.scrollToXRatio} />
      <PtyConnectionOverlay {...view.connectionOverlay} />
      {view.traceEnabled ? <PtyScrollTraceButton /> : null}
    </div>
  );
}

function PtyScrollTraceButton() {
  const [copied, setCopied] = useState(false);

  async function handleClick(): Promise<void> {
    const text = formatPtyScrollTraceReport();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      window.prompt("Copy PTY scroll trace", text);
    }
  }

  return (
    <button
      type="button"
      className="absolute left-3 top-3 z-30 rounded border border-[#4A4A4A] bg-[#1E1E1E]/90 px-2 py-1 text-[11px] text-[#C8C8C8]"
      onPointerDown={(event) => event.preventDefault()}
      onClick={handleClick}
      data-slot="pty-scroll-trace-copy"
    >
      {copied ? "Copied" : "Trace"}
    </button>
  );
}
