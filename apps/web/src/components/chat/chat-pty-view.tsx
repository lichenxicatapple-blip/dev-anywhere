// PTY 模式保留 provider 原生 TUI，Web 只负责滚动和输入转发。
// 浏览器滚动容器映射到 xterm viewportY；当真实 PTY 屏幕比 Web 可视区矮时，
// scroll spacer 仍保证底部位置能映射到 xterm baseY，而不是伪造额外终端行。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, FocusEvent, MouseEvent, PointerEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from "lucide-react";
import { createXtermTerminal } from "@/lib/create-xterm";
import { applyPtyFontSize } from "@/lib/pty-font-size-controller";
import { attachXtermRawInput } from "@/lib/pty-input";
import { attachPtyResizeController } from "@/lib/pty-resize-controller";
import { attachPtyScrollController } from "@/lib/pty-scroll-controller";
import type { PtyScrollState } from "@/lib/pty-scroll-controller";
import { formatPtyScrollTraceReport, isPtyScrollTraceEnabled } from "@/lib/pty-scroll-trace";
import { attachPtyTerminalController } from "@/lib/pty-terminal-controller";
import { createRafScheduler } from "@/lib/raf-scheduler";
import type { RafScheduler } from "@/lib/raf-scheduler";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { getClipboardImageFile } from "@/lib/clipboard-image";
import { uploadClipboardImageFromPaste } from "@/lib/clipboard-image-upload";
import { registerPtySerializer, registerPtyTerminal } from "@/test-hooks";
import { toast } from "@/components/toast";
import { BackToBottom } from "./back-to-bottom";
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
  const touchPointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressPtyFocusUntilRef = useRef(0);
  const connection = usePtyConnectionState();
  const follow = usePtyFollowState();
  const clearNewFramesWhileAway = follow.clearNewFramesWhileAway;
  const hasNewFramesWhileAwayRef = follow.hasNewFramesWhileAwayRef;
  const setHasNewFramesWhileAway = follow.setHasNewFramesWhileAway;
  const [traceEnabled, setTraceEnabled] = useState(() => isPtyScrollTraceEnabled());
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
  const [ptyInputFocused, setPtyInputFocused] = useState(false);
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const webOwnsPtyGeometry = ptyOwner === "proxy-hosted";
  const touchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const ptyPlainEnterBehavior = touchEditingSurface ? "linefeed" : "submit";
  const showMobilePtyControls = touchEditingSurface && ptyInputFocused;

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

  const blurFocusedPtyInput = useCallback((): void => {
    const container = containerEl;
    const active = document.activeElement;
    if (!container || !(active instanceof HTMLElement) || !container.contains(active)) return;
    active.blur();
  }, [containerEl]);

  const syncPtyInputFocus = useCallback((): void => {
    const host = xtermHostRef.current;
    const active = document.activeElement;
    setPtyInputFocused(Boolean(host && active instanceof HTMLElement && host.contains(active)));
  }, []);

  const suppressPtyFocus = useCallback((): void => {
    suppressPtyFocusUntilRef.current = performance.now() + 900;
    blurFocusedPtyInput();
    setPtyInputFocused(false);
  }, [blurFocusedPtyInput]);

  function handleTerminalContainerMouseDown(event: MouseEvent<HTMLDivElement>): void {
    const target = event.target;
    if (target instanceof Element && target.closest(".xterm")) return;
    // 空白 spacer 区域不是 xterm DOM。浏览器默认 mousedown 会把焦点从
    // xterm helper textarea 移到 body，导致后续方向键/Enter 不再进入 PTY。
    event.preventDefault();
    terminalRef.current?.focus();
  }

  function handleTerminalPointerDownCapture(event: PointerEvent<HTMLDivElement>): void {
    if (event.pointerType !== "touch") return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".xterm")) return;
    touchPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.stopPropagation();
  }

  function handleTerminalPointerMoveCapture(event: PointerEvent<HTMLDivElement>): void {
    const gesture = touchPointerRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) >= 8) {
      gesture.moved = true;
      suppressPtyFocus();
    }
    if (gesture.moved) event.stopPropagation();
  }

  function handleTerminalPointerUpCapture(event: PointerEvent<HTMLDivElement>): void {
    const gesture = touchPointerRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    touchPointerRef.current = null;
    event.stopPropagation();
    if (gesture.moved) {
      suppressPtyFocus();
      return;
    }
    terminalRef.current?.focus();
  }

  function handleTerminalPointerCancelCapture(event: PointerEvent<HTMLDivElement>): void {
    if (touchPointerRef.current?.pointerId !== event.pointerId) return;
    touchPointerRef.current = null;
    suppressPtyFocus();
  }

  function handleTerminalFocusCapture(event: FocusEvent<HTMLDivElement>): void {
    if (performance.now() <= suppressPtyFocusUntilRef.current) {
      if (event.target instanceof HTMLElement) event.target.blur();
      window.setTimeout(syncPtyInputFocus, 0);
      return;
    }
    syncPtyInputFocus();
  }

  function handleTerminalBlurCapture(): void {
    window.setTimeout(syncPtyInputFocus, 0);
  }

  const handleTerminalPasteCapture = useCallback(
    async (event: ClipboardEvent<HTMLDivElement>): Promise<void> => {
      if (!getClipboardImageFile(event.clipboardData)) return;
      event.preventDefault();
      event.stopPropagation();

      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }

      try {
        const result = await uploadClipboardImageFromPaste({
          clipboardData: event.clipboardData,
          relay,
          sessionId,
        });
        if (!result) return;
        sendRemoteInputRaw(sessionId, result.token);
        rawInputFollowSchedulerRef.current?.schedule();
        terminalRef.current?.focus();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId],
  );

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
        registerPtySerializer(sessionId, () => serializeTerminalBuffer(term as Terminal));
        registerPtyTerminal(sessionId, term as Terminal);
      },
      onFramePending: () => {
        pendingNewFrameRef.current = true;
        if (userHasVerticalScrollIntentRef.current && !hasNewFramesWhileAwayRef.current) {
          setHasNewFramesWhileAway(true);
        }
      },
      onFrameWritten: () => {
        relayoutSchedulerRef.current?.schedule();
      },
      onRawInput: () => {
        rawInputFollowSchedulerRef.current?.schedule();
      },
      ...connection.transport,
    });
    terminalControllerRef.current = controller;

    return () => {
      controller.dispose();
      registerPtySerializer(sessionId, null);
      registerPtyTerminal(sessionId, null);
      terminalRef.current = null;
      terminalControllerRef.current = null;
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
    const updateTraceEnabled = (): void => {
      setTraceEnabled(isPtyScrollTraceEnabled());
    };
    updateTraceEnabled();
    window.addEventListener("hashchange", updateTraceEnabled);
    window.addEventListener("popstate", updateTraceEnabled);
    return () => {
      window.removeEventListener("hashchange", updateTraceEnabled);
      window.removeEventListener("popstate", updateTraceEnabled);
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
    return () => {
      controller.dispose();
      relayoutPtyRef.current = () => {};
      scrollToBottomRef.current = () => {};
      scrollToRatioRef.current = () => {};
      scrollToXRatioRef.current = () => {};
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
        onPointerDownCapture={handleTerminalPointerDownCapture}
        onPointerMoveCapture={handleTerminalPointerMoveCapture}
        onPointerUpCapture={handleTerminalPointerUpCapture}
        onPointerCancelCapture={handleTerminalPointerCancelCapture}
        onPasteCapture={handleTerminalPasteCapture}
        onFocusCapture={handleTerminalFocusCapture}
        onBlurCapture={handleTerminalBlurCapture}
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
            ? "right-14 bottom-[calc(env(safe-area-inset-bottom)+4rem)]"
            : "right-14"
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

interface PtyMobileControlsProps {
  onInput: (data: string) => void;
}

function PtyMobileControls({ onInput }: PtyMobileControlsProps) {
  const keys = [
    { label: "光标左移", slot: "pty-mobile-key-left", data: "\x1b[D", icon: ArrowLeft },
    { label: "光标上移", slot: "pty-mobile-key-up", data: "\x1b[A", icon: ArrowUp },
    { label: "光标下移", slot: "pty-mobile-key-down", data: "\x1b[B", icon: ArrowDown },
    { label: "光标右移", slot: "pty-mobile-key-right", data: "\x1b[C", icon: ArrowRight },
  ];

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-1 border-t border-[#343434] bg-[#202020]/[0.98] px-1 py-1.5 shadow-[0_-10px_24px_rgba(0,0,0,0.35)]"
      data-slot="pty-mobile-controls"
      aria-label="终端移动端控制"
    >
      <div className="grid min-w-0 flex-1 grid-cols-5 gap-1" role="group" aria-label="辅助按键">
        <button
          type="button"
          className="inline-flex h-11 min-w-0 items-center justify-center rounded-[6px] text-[#D8D8D8] transition-colors active:text-white"
          aria-label="清空当前输入"
          data-slot="pty-mobile-key-clear"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onInput("\x15")}
        >
          <span className="inline-flex h-9 min-w-0 items-center justify-center rounded-[6px] border border-[#3A3A3A] bg-[#1A1A1A] px-1.5 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            清空
          </span>
        </button>
        {keys.map(({ label, slot, data, icon: Icon }) => (
          <button
            key={slot}
            type="button"
            className="inline-flex h-11 min-w-0 items-center justify-center rounded-[6px] text-[#D8D8D8] transition-colors active:text-white"
            aria-label={label}
            data-slot={slot}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onInput(data)}
          >
            <span className="inline-flex size-9 items-center justify-center rounded-[6px] border border-[#3A3A3A] bg-[#1A1A1A] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <Icon aria-hidden="true" className="size-4" />
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="inline-flex h-11 w-[4.375rem] shrink-0 items-center justify-center rounded-[6px] text-sm text-[#F1E0CB] transition-colors active:text-white"
        aria-label="回车"
        data-slot="pty-mobile-key-enter"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => onInput("\r")}
      >
        <span className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[#7A6046] bg-[#5A452E] px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          <CornerDownLeft aria-hidden="true" className="size-4" />
          <span>回车</span>
        </span>
      </button>
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
