// PTY 模式保留 provider 原生 TUI，Web 只负责滚动和输入转发。
// 浏览器滚动容器映射到 xterm viewportY；当真实 PTY 屏幕比 Web 可视区矮时，
// scroll spacer 仍保证底部位置能映射到 xterm baseY，而不是伪造额外终端行。
//
// 编排（4 个 controller 的生命周期 + 调度器 + debug 注册）全部下沉到 usePtyView，
// 本组件仅负责 DOM 结构与 JSX 接线。
import { useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from "react";
import { formatPtyScrollTraceReport } from "@/lib/pty-scroll-trace";
import type { SessionProvider } from "@/lib/session-provider";
import { BackToBottom } from "./back-to-bottom";
import { PtyConnectionOverlay } from "./pty-connection-overlay";
import { PtyInputDebugPanel } from "./pty-input-debug-panel";
import { PtyMobileControls } from "./pty-mobile-controls";
import { PtyHorizontalScrollbar, PtyScrollbar } from "./pty-scrollbar";
import { usePtyView } from "./use-pty-view";

interface ChatPtyViewProps {
  sessionId: string;
  sessionKind?: "agent" | "terminal";
  provider?: SessionProvider;
  ptyOwner?: "local-terminal" | "proxy-hosted";
  active?: boolean;
}

export function ChatPtyView({
  sessionId,
  sessionKind,
  provider,
  ptyOwner,
  active = true,
}: ChatPtyViewProps) {
  // containerEl 用 state 是为了让 scroll controller 在 DOM 挂载后初始化
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);

  const view = usePtyView({
    sessionId,
    sessionKind,
    ptyOwner,
    active,
    containerEl,
    spacerRef,
    xtermHostRef,
  });
  const handleMetrics = view.ptySelectionHandleMetrics;
  const accessoryMotionShift = usePtyAccessoryMotionShift(
    view.accessoryBottomInset,
    Boolean(view.ptySelectionHandles),
  );

  return (
    <div className="flex flex-col h-full relative" data-slot="chat-pty-view">
      <div
        ref={setContainerEl}
        className="flex-1 min-h-0 overflow-auto overscroll-contain bg-background px-3 pt-2"
        style={{
          paddingBottom: `calc(env(safe-area-inset-bottom) + ${view.containerPaddingBottom}px)`,
          touchAction: "pan-x pan-y",
          overflowAnchor: "none",
        }}
        onMouseDownCapture={view.handleTerminalContainerMouseDown}
        onPointerDownCapture={view.pointerHandlers.onPointerDownCapture}
        onPointerMoveCapture={view.pointerHandlers.onPointerMoveCapture}
        onPointerUpCapture={view.pointerHandlers.onPointerUpCapture}
        onPointerCancelCapture={view.pointerHandlers.onPointerCancelCapture}
        onTouchStartCapture={view.pointerHandlers.onTouchStartCapture}
        onTouchMoveCapture={view.pointerHandlers.onTouchMoveCapture}
        onTouchEndCapture={view.pointerHandlers.onTouchEndCapture}
        onTouchCancelCapture={view.pointerHandlers.onTouchCancelCapture}
        onContextMenuCapture={view.pointerHandlers.onContextMenuCapture}
        onPasteCapture={view.handlePasteCapture}
        onDragOver={view.handlePtyDragOver}
        onDragLeave={view.handlePtyDragLeave}
        onDrop={view.handlePtyDrop}
        onFocusCapture={view.focusHandlers.onFocusCapture}
        onBlurCapture={view.focusHandlers.onBlurCapture}
        data-slot="pty-terminal"
        data-drag-over={view.isPtyDragOver ? "true" : undefined}
      >
        <div
          ref={spacerRef}
          style={{ position: "relative", overflowAnchor: "none" }}
          data-slot="pty-spacer"
        >
          <div
            ref={xtermHostRef}
            className="transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              overflow: "hidden",
              overflowAnchor: "none",
              boxSizing: "border-box",
              transform:
                accessoryMotionShift === 0 ? undefined : `translateY(${accessoryMotionShift}px)`,
              willChange: accessoryMotionShift === 0 ? undefined : "transform",
            }}
            data-slot="pty-host"
          />
        </div>
      </div>
      <BackToBottom
        visible={!view.isAtBottom}
        hasNewMessages={view.hasNewFramesWhileAway}
        className="top-10"
        onClick={() => {
          // 用户明示动作: 压过 intent (即便用户在回看, 点这个按钮就是要退出回看)。
          view.scrollToBottom("backToBottomBtn", { force: true });
          view.clearNewFramesWhileAway();
        }}
      />
      {view.showMobilePtyControls ? (
        <PtyMobileControls
          sessionKind={sessionKind}
          provider={provider}
          bottomInset={view.mobileControlsBottomInset}
          onInput={view.sendMobileInput}
          onPaste={view.pasteMobileClipboard}
        />
      ) : null}
      {view.ptySelectionHandles ? (
        <>
          <PtySelectionHandle
            kind="anchor"
            position={view.ptySelectionHandles.anchor}
            metrics={handleMetrics}
            aria-label="调整选区起点"
            onPointerDown={(event) => view.handlePtySelectionHandlePointerDown("anchor", event)}
            onTouchStart={(event) => view.handlePtySelectionHandleTouchStart("anchor", event)}
          />
          <PtySelectionHandle
            kind="focus"
            position={view.ptySelectionHandles.focus}
            metrics={handleMetrics}
            aria-label="调整选区终点"
            onPointerDown={(event) => view.handlePtySelectionHandlePointerDown("focus", event)}
            onTouchStart={(event) => view.handlePtySelectionHandleTouchStart("focus", event)}
          />
        </>
      ) : null}
      {view.ptySelectionToolbar ? (
        <div
          className="fixed z-50 flex -translate-x-1/2 gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ left: view.ptySelectionToolbar.left, top: view.ptySelectionToolbar.top }}
          data-slot="pty-selection-toolbar"
        >
          <button
            type="button"
            className="min-w-14 whitespace-nowrap rounded px-3 py-1.5 text-center text-sm font-medium leading-none hover:bg-accent active:bg-accent/80"
            onPointerDown={(event) => event.preventDefault()}
            onClick={view.copyPtySelection}
            aria-label="复制终端选区"
          >
            复制
          </button>
          {view.ptySelectionPathAction ? (
            <button
              type="button"
              className="min-w-14 whitespace-nowrap rounded px-3 py-1.5 text-center text-sm font-medium leading-none hover:bg-accent active:bg-accent/80"
              onPointerDown={(event) => event.preventDefault()}
              onClick={view.openPtySelectionPathAction}
              aria-label={
                view.ptySelectionPathAction.kind === "image-preview"
                  ? "预览终端选区图片"
                  : "下载终端选区文件"
              }
            >
              {view.ptySelectionPathAction.kind === "image-preview" ? "预览" : "下载"}
            </button>
          ) : null}
        </div>
      ) : null}
      <PtyScrollbar state={view.scrollState} onScrollRatio={view.scrollToRatio} />
      <PtyHorizontalScrollbar state={view.scrollState} onScrollRatio={view.scrollToXRatio} />
      <PtyConnectionOverlay {...view.connectionOverlay} />
      <PtyInputDebugPanel
        ptyInputFocused={view.ptyInputFocused}
        touchEditingSurface={view.touchEditingSurface}
        softKeyboardEditingSurface={view.softKeyboardEditingSurface}
        physicalKeyboardMode={view.physicalKeyboardMode}
        keyboardOffset={view.keyboardOffset}
        rawKeyboardOffset={view.rawKeyboardOffset}
        rawKeyboardLayoutInset={view.rawKeyboardLayoutInset}
        accessoryBottomInset={view.accessoryBottomInset}
        viewportOcclusionKind={view.viewportOcclusionKind}
        viewportOcclusionReason={view.viewportOcclusionReason}
        showMobilePtyControls={view.showMobilePtyControls}
        mobileControlsBottomInset={view.mobileControlsBottomInset}
      />
      {view.traceEnabled ? <PtyScrollTraceButton /> : null}
    </div>
  );
}

interface PtySelectionHandleProps {
  kind: "anchor" | "focus";
  position: { left: number; top: number };
  metrics: { visualSize: number; stemSize: number; touchSize: number };
  "aria-label": string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLButtonElement>) => void;
}

function PtySelectionHandle({
  kind,
  position,
  metrics,
  "aria-label": ariaLabel,
  onPointerDown,
  onTouchStart,
}: PtySelectionHandleProps) {
  const center = metrics.touchSize / 2;
  const stroke = 2;
  const bulb = metrics.visualSize;
  const stem = Math.max(metrics.stemSize + 2, bulb + 1);
  const x = center - stroke / 2;
  const y = center;
  const bulbLeft = kind === "anchor" ? x - bulb + stroke : x;
  const bulbTop = y + stem - bulb + stroke;
  const radii =
    kind === "anchor"
      ? {
          borderTopLeftRadius: bulb,
          borderBottomLeftRadius: bulb,
          borderTopRightRadius: 2,
          borderBottomRightRadius: bulb,
        }
      : {
          borderTopLeftRadius: 2,
          borderBottomLeftRadius: bulb,
          borderTopRightRadius: bulb,
          borderBottomRightRadius: bulb,
        };

  return (
    <button
      type="button"
      className="fixed z-50 touch-none rounded-full bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      style={{
        left: position.left,
        top: position.top,
        width: metrics.touchSize,
        height: metrics.touchSize,
        transform: "translate(-50%, -50%)",
      }}
      data-slot="pty-selection-handle"
      data-kind={kind}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onTouchStart={onTouchStart}
    >
      <span
        className="pointer-events-none absolute rounded-full bg-primary"
        style={{
          left: x,
          top: y,
          width: stroke,
          height: stem,
        }}
        data-slot="pty-selection-handle-stem"
      />
      <span
        className="pointer-events-none absolute border-2 border-primary bg-background shadow-sm shadow-black/30"
        style={{
          left: bulbLeft,
          top: bulbTop,
          width: bulb,
          height: bulb,
          ...radii,
        }}
        data-slot="pty-selection-handle-dot"
      />
    </button>
  );
}

function usePtyAccessoryMotionShift(accessoryBottomInset: number, disabled: boolean): number {
  const previousInsetRef = useRef(accessoryBottomInset);
  const frameIdsRef = useRef<number[]>([]);
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    frameIdsRef.current.forEach((frameId) => window.cancelAnimationFrame(frameId));
    frameIdsRef.current = [];

    const previousInset = previousInsetRef.current;
    previousInsetRef.current = accessoryBottomInset;
    const delta = accessoryBottomInset - previousInset;

    if (disabled || Math.abs(delta) < 1) {
      setShift(0);
      return;
    }

    setShift(delta);
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        frameIdsRef.current = [];
        setShift(0);
      });
      frameIdsRef.current.push(secondFrame);
    });
    frameIdsRef.current.push(firstFrame);

    return () => {
      frameIdsRef.current.forEach((frameId) => window.cancelAnimationFrame(frameId));
      frameIdsRef.current = [];
    };
  }, [accessoryBottomInset, disabled]);

  return shift;
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
      className="absolute left-3 top-3 z-30 rounded border border-border bg-popover/90 px-2 py-1 text-[11px] text-muted-foreground"
      onPointerDown={(event) => event.preventDefault()}
      onClick={handleClick}
      data-slot="pty-scroll-trace-copy"
    >
      {copied ? "Copied" : "Trace"}
    </button>
  );
}
