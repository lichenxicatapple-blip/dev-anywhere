// PTY 模式保留 provider 原生 TUI，Web 只负责滚动和输入转发。
// 浏览器滚动容器映射到 xterm viewportY；当真实 PTY 屏幕比 Web 可视区矮时，
// scroll spacer 仍保证底部位置能映射到 xterm baseY，而不是伪造额外终端行。
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import { createXtermTerminal } from "@/lib/create-xterm";
import { applyPtyFontSize } from "@/lib/pty-font-size-controller";
import { attachXtermRawInput } from "@/lib/pty-input";
import { attachPtyResizeController } from "@/lib/pty-resize-controller";
import { attachPtyScrollController } from "@/lib/pty-scroll-controller";
import type { PtyScrollState } from "@/lib/pty-scroll-controller";
import { formatPtyScrollTraceReport } from "@/lib/pty-scroll-trace";
import { attachPtyTerminalController } from "@/lib/pty-terminal-controller";
import { registerImagePreviewLinkProvider } from "@/lib/xterm-image-preview-links";
import { createRafScheduler } from "@/lib/raf-scheduler";
import type { RafScheduler } from "@/lib/raf-scheduler";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import {
  registerPtyDebugSnapshotProvider,
  registerPtyTerminalWindowAccessor,
  unregisterPtyDebugSnapshotProvider,
  unregisterPtyTerminalWindowAccessor,
} from "@/lib/pty-debug-snapshot";
import { getPtyDebug } from "@/lib/pty-render-debug";
import { registerPtySerializer, registerPtyTerminal } from "@/test-hooks";
import { PtyMobileControls } from "./pty-mobile-controls";
import { usePtyFocusState } from "./use-pty-focus-state";
import { usePtyScrollTraceEnabled } from "./use-pty-scroll-trace-enabled";
import { usePtyTouchGesture } from "./use-pty-touch-gesture";
import { useTerminalPaste } from "./use-terminal-paste";
import { toast } from "@/components/toast";
import { BackToBottom } from "./back-to-bottom";
import { useImagePreview } from "./image-preview";
import { PtyConnectionOverlay } from "./pty-connection-overlay";
import { PtyHorizontalScrollbar, PtyScrollbar } from "./pty-scrollbar";
import { usePtyConnectionState } from "./use-pty-connection-state";
import { usePtyFollowState } from "./use-pty-follow-state";

interface ChatPtyViewProps {
  sessionId: string;
  ptyOwner?: "local-terminal" | "proxy-hosted";
}

export function ChatPtyView({ sessionId, ptyOwner }: ChatPtyViewProps) {
  // containerEl 用 state 是为了让 scroll controller 在 DOM 挂载后初始化
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const imageLinkProviderDisposeRef = useRef<(() => void) | null>(null);
  const ptyDebugDeregisterRef = useRef<(() => void) | null>(null);
  const terminalControllerRef = useRef<{
    flushOutput: () => void;
    setOutputPaused: (value: boolean) => void;
  } | null>(null);
  const relayoutPtyRef = useRef<() => void>(() => {});
  const scrollToBottomRef = useRef<() => void>(() => {});
  const scrollToRatioRef = useRef<(ratio: number) => void>(() => {});
  const scrollToXRatioRef = useRef<(ratio: number) => void>(() => {});
  const relayoutSchedulerRef = useRef<RafScheduler | null>(null);
  const rawInputFollowSchedulerRef = useRef<RafScheduler | null>(null);
  const lastFrameWriteAtRef = useRef<number | null>(null);
  const connection = usePtyConnectionState();
  const follow = usePtyFollowState();
  const clearNewFramesWhileAway = follow.clearNewFramesWhileAway;
  const hasNewFramesWhileAwayRef = follow.hasNewFramesWhileAwayRef;
  const setHasNewFramesWhileAway = follow.setHasNewFramesWhileAway;
  const traceEnabled = usePtyScrollTraceEnabled();
  const [scrollState, setScrollState] = useState<PtyScrollState>({
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
    scrollable: false,
    horizontalScrollable: false,
  });
  // xterm.onRender 会在用户 scroll 触发 ydisp 变化时也跑 (canvas 重绘),
  // 不做来源区分会把"scroll 触发的 render"误判为"新帧到达" → 红点虚亮 / scroll 被 follow 拉回.
  // 用 ref flag 标记 "真的有新帧到达", subscribeBinary 收到数据时 set, onRender 消费后清零.
  const pendingNewFrameRef = useRef(false);
  const userHasVerticalScrollIntentRef = useRef(false);
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const webOwnsPtyGeometry = ptyOwner === "proxy-hosted";
  const touchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const ptyPlainEnterBehavior = touchEditingSurface ? "linefeed" : "submit";
  const keyboardOffset = useVisualViewportBottomOffset();
  const [hasSeenSoftKeyboard, setHasSeenSoftKeyboard] = useState(false);
  useEffect(() => {
    if (keyboardOffset > 0) setHasSeenSoftKeyboard(true);
  }, [keyboardOffset]);
  const softKeyboardOpenOrUnknown = !hasSeenSoftKeyboard || keyboardOffset > 0;
  const { openImagePreview } = useImagePreview();

  if (!relayoutSchedulerRef.current) {
    relayoutSchedulerRef.current = createRafScheduler(() => {
      relayoutPtyRef.current();
    });
  }
  if (!rawInputFollowSchedulerRef.current) {
    rawInputFollowSchedulerRef.current = createRafScheduler(() => {
      scrollToBottomRef.current();
      clearNewFramesWhileAway();
    });
  }

  const focusState = usePtyFocusState({ containerEl, xtermHostRef, terminalRef });
  const { ptyInputFocused, suppressPtyFocus } = focusState;
  const showMobilePtyControls = touchEditingSurface && ptyInputFocused && softKeyboardOpenOrUnknown;

  function handleTerminalContainerMouseDown(event: MouseEvent<HTMLDivElement>): void {
    const target = event.target;
    if (target instanceof Element && target.closest(".xterm")) return;
    // 空白 spacer 区域不是 xterm DOM。浏览器默认 mousedown 会把焦点从
    // xterm helper textarea 移到 body，导致后续方向键/Enter 不再进入 PTY。
    event.preventDefault();
    terminalRef.current?.focus();
  }

  const touchGestureHandlers = usePtyTouchGesture({ terminalRef, suppressPtyFocus });

  const handleTerminalPasteCapture = useTerminalPaste({
    sessionId,
    terminalRef,
    onAfterPaste: () => rawInputFollowSchedulerRef.current?.schedule(),
  });

  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const host = xtermHostRef.current;
    const ws = wsManagerRef;
    const relay = relayClientRef;
    if (!host || !ws || !relay) return;
    const controller = attachPtyTerminalController({
      host,
      sessionId,
      ws,
      relay,
      createTerminal: (container) =>
        createXtermTerminal(container, { fontSize: useAppStore.getState().ptyFontSize }),
      attachRawInput: (term, rawSessionId, options) =>
        attachXtermRawInput(term, rawSessionId, {
          ...options,
          plainEnterBehavior: ptyPlainEnterBehavior,
        }),
      onTerminalReady: (term) => {
        terminalRef.current = term as Terminal;
        imageLinkProviderDisposeRef.current?.();
        imageLinkProviderDisposeRef.current = registerImagePreviewLinkProvider(
          term as Terminal,
          openImagePreview,
        ).dispose;
        registerPtySerializer(sessionId, () => serializeTerminalBuffer(term as Terminal));
        registerPtyTerminal(sessionId, term as Terminal);
        registerPtyTerminalWindowAccessor(() => terminalRef.current);
        ptyDebugDeregisterRef.current = getPtyDebug().registerTerminal(sessionId, {
          // 强制整屏重绘绕过 atlas 缓存——给"鼠标选中后正常显示"这种 cell 残留 bug 用。
          refresh: () => (term as Terminal).refresh(0, (term as Terminal).rows - 1),
          serialize: () => serializeTerminalBuffer(term as Terminal),
          describe: () => ({
            sessionId,
            cols: (term as Terminal).cols,
            rows: (term as Terminal).rows,
          }),
        });
      },
      onFramePending: () => {
        pendingNewFrameRef.current = true;
        if (userHasVerticalScrollIntentRef.current && !hasNewFramesWhileAwayRef.current) {
          setHasNewFramesWhileAway(true);
        }
      },
      onFrameWritten: () => {
        lastFrameWriteAtRef.current = performance.now();
        relayoutSchedulerRef.current?.schedule();
      },
      onRawInput: () => {
        rawInputFollowSchedulerRef.current?.schedule();
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`终端初始化失败：${message}`);
      },
      ...connection.transport,
    });
    terminalControllerRef.current = controller;

    return () => {
      controller.dispose();
      imageLinkProviderDisposeRef.current?.();
      imageLinkProviderDisposeRef.current = null;
      ptyDebugDeregisterRef.current?.();
      ptyDebugDeregisterRef.current = null;
      registerPtySerializer(sessionId, null);
      registerPtyTerminal(sessionId, null);
      terminalRef.current = null;
      terminalControllerRef.current = null;
      unregisterPtyTerminalWindowAccessor();
    };
  }, [
    sessionId,
    connected,
    proxyOnline,
    connection.transport,
    clearNewFramesWhileAway,
    hasNewFramesWhileAwayRef,
    setHasNewFramesWhileAway,
    ptyPlainEnterBehavior,
    openImagePreview,
  ]);

  useEffect(() => {
    return () => {
      relayoutSchedulerRef.current?.dispose();
      rawInputFollowSchedulerRef.current?.dispose();
      relayoutSchedulerRef.current = null;
      rawInputFollowSchedulerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!connection.ready) return;
    const container = containerEl;
    const spacer = spacerRef.current;
    const host = xtermHostRef.current;
    const term = terminalRef.current;
    if (!container || !spacer || !host || !term) return;

    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term,
      hasNewFrame: () => pendingNewFrameRef.current,
      consumeNewFrame: () => {
        pendingNewFrameRef.current = false;
      },
      hasNewFramesWhileAway: () => follow.hasNewFramesWhileAwayRef.current,
      setNewFramesWhileAway: follow.setHasNewFramesWhileAway,
      onAtBottomChange: follow.handleAtBottomChange,
      onScrollStateChange: setScrollState,
      initialUserHasVerticalScrollIntent: userHasVerticalScrollIntentRef.current,
      onUserVerticalScrollIntentChange: (value) => {
        userHasVerticalScrollIntentRef.current = value;
        terminalControllerRef.current?.setOutputPaused(value);
        if (!value) terminalControllerRef.current?.flushOutput();
      },
      onTouchReviewStart: suppressPtyFocus,
    });
    relayoutPtyRef.current = controller.relayout;
    scrollToBottomRef.current = controller.scrollToBottom;
    scrollToRatioRef.current = controller.scrollToRatio;
    scrollToXRatioRef.current = controller.scrollToXRatio;
    registerPtyDebugSnapshotProvider(() => ({
      ...controller.getDebugSnapshot(),
      frame: {
        lastWriteAt: lastFrameWriteAtRef.current,
        pendingNewFrame: pendingNewFrameRef.current,
      },
    }));
    return () => {
      controller.dispose();
      relayoutPtyRef.current = () => {};
      scrollToBottomRef.current = () => {};
      scrollToRatioRef.current = () => {};
      scrollToXRatioRef.current = () => {};
      unregisterPtyDebugSnapshotProvider();
    };
  }, [
    connection.ready,
    containerEl,
    follow.handleAtBottomChange,
    follow.hasNewFramesWhileAwayRef,
    follow.setHasNewFramesWhileAway,
    suppressPtyFocus,
  ]);

  useEffect(() => {
    if (!connection.ready) return;
    const term = terminalRef.current;
    if (!term) return;

    applyPtyFontSize(term, ptyFontSize, () => relayoutPtyRef.current());
  }, [connection.ready, ptyFontSize]);

  useEffect(() => {
    if (!connection.ready || !webOwnsPtyGeometry) return;
    const container = containerEl;
    const term = terminalRef.current;
    const relay = relayClientRef;
    if (!container || !term || !relay) return;

    const controller = attachPtyResizeController({
      container,
      term,
      onResize: (cols, rows) => {
        relay.sendControl({ type: "terminal_resize_request", sessionId, cols, rows });
      },
      onRelayout: () => relayoutPtyRef.current(),
    });
    return () => controller.dispose();
  }, [connection.ready, webOwnsPtyGeometry, ptyFontSize, containerEl, sessionId]);

  function sendMobilePtyInput(data: string): void {
    sendRemoteInputRaw(sessionId, data);
    rawInputFollowSchedulerRef.current?.schedule();
    terminalRef.current?.focus();
  }

  return (
    <div className="flex flex-col h-full relative" data-slot="chat-pty-view">
      <div
        ref={setContainerEl}
        className="flex-1 min-h-0 overflow-auto overscroll-contain bg-[#1E1E1E] px-3 pt-2"
        style={{
          paddingBottom: showMobilePtyControls ? 64 : scrollState.horizontalScrollable ? 32 : 8,
          touchAction: "pan-x pan-y",
        }}
        onMouseDownCapture={handleTerminalContainerMouseDown}
        onPointerDownCapture={touchGestureHandlers.onPointerDownCapture}
        onPointerMoveCapture={touchGestureHandlers.onPointerMoveCapture}
        onPointerUpCapture={touchGestureHandlers.onPointerUpCapture}
        onPointerCancelCapture={touchGestureHandlers.onPointerCancelCapture}
        onPasteCapture={handleTerminalPasteCapture}
        onFocusCapture={focusState.handleFocusCapture}
        onBlurCapture={focusState.handleBlurCapture}
        data-slot="pty-terminal"
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
        visible={!follow.isAtBottom}
        hasNewMessages={follow.hasNewFramesWhileAway}
        className={
          showMobilePtyControls
            ? "right-6 bottom-[calc(env(safe-area-inset-bottom)+4rem)]"
            : touchEditingSurface
              ? "right-6"
              : "right-12"
        }
        onClick={() => {
          scrollToBottomRef.current();
          follow.clearNewFramesWhileAway();
        }}
      />
      {showMobilePtyControls ? <PtyMobileControls onInput={sendMobilePtyInput} /> : null}
      <PtyScrollbar
        state={scrollState}
        onScrollRatio={(ratio) => scrollToRatioRef.current(ratio)}
      />
      <PtyHorizontalScrollbar
        state={scrollState}
        onScrollRatio={(ratio) => scrollToXRatioRef.current(ratio)}
      />
      <PtyConnectionOverlay {...connection.overlay} />
      {traceEnabled ? <PtyScrollTraceButton /> : null}
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
      className="absolute left-3 bottom-3 z-30 rounded border border-[#4A4A4A] bg-[#1E1E1E]/90 px-2 py-1 text-[11px] text-[#C8C8C8]"
      onClick={handleClick}
      data-slot="pty-scroll-trace-copy"
    >
      {copied ? "Copied" : "Trace"}
    </button>
  );
}

function serializeTerminalBuffer(term: Terminal): string {
  const activeBuffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < activeBuffer.length; i += 1) {
    lines.push(activeBuffer.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}
