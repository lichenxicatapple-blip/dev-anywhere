// PTY 视图编排 hook：把 4 个 controller（terminal / scroll / resize / font-size）
// 的 bringup 顺序、命令式句柄、调试注册、image preview link provider 等横切关注点
// 集中到这里，让 chat-pty-view.tsx 退化为纯 JSX shell。
//
// 关键设计：单一 effect 在 attachPtyTerminalController 的 onTerminalReady 回调里
// 就近挂 scroll/resize/debug——typed handshake 替代之前依赖 React state 重渲染的
// 跨 effect 隐式 ref 协议。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { createXtermTerminal } from "@/lib/create-xterm";
import { applyPtyFontSize } from "@/lib/pty-font-size-controller";
import { attachXtermRawInput } from "@/lib/pty-input";
import { attachPtyResizeController } from "@/lib/pty-resize-controller";
import {
  attachPtyScrollController,
  type PtyScrollState,
} from "@/lib/pty-scroll-controller";
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
import { buildPtyScrollDebugSnapshot } from "@/lib/pty-scroll-debug-snapshot";
import { getPtyDebug } from "@/lib/pty-render-debug";
import { serializeTerminalBuffer } from "@/lib/pty-serialize-buffer";
import { registerPtySerializer, registerPtyTerminal } from "@/test-hooks";
import { toast } from "@/components/toast";
import { useImagePreview } from "./image-preview";
import { usePtyConnectionState } from "./use-pty-connection-state";
import { usePtyFocusState } from "./use-pty-focus-state";
import { usePtyFollowState } from "./use-pty-follow-state";
import { usePtyScrollTraceEnabled } from "./use-pty-scroll-trace-enabled";
import { usePtyTouchGesture } from "./use-pty-touch-gesture";
import { useTerminalPaste } from "./use-terminal-paste";

interface UsePtyViewOptions {
  sessionId: string;
  ptyOwner?: "local-terminal" | "proxy-hosted";
  containerEl: HTMLDivElement | null;
  spacerRef: RefObject<HTMLDivElement | null>;
  xtermHostRef: RefObject<HTMLDivElement | null>;
}

interface PointerHandlers {
  onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
}

interface FocusHandlers {
  onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => void;
  onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => void;
}

export interface UsePtyViewResult {
  scrollState: PtyScrollState;
  isAtBottom: boolean;
  hasNewFramesWhileAway: boolean;
  ptyInputFocused: boolean;
  showMobilePtyControls: boolean;
  touchEditingSurface: boolean;
  connectionOverlay: { connecting: boolean; subscribeDelayed: boolean };
  containerPaddingBottom: number;
  traceEnabled: boolean;
  scrollToBottom: () => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  clearNewFramesWhileAway: () => void;
  sendMobileInput: (data: string) => void;
  handleTerminalContainerMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  handlePasteCapture: (event: ClipboardEvent<HTMLDivElement>) => void;
  pointerHandlers: PointerHandlers;
  focusHandlers: FocusHandlers;
}

interface ScrollControllerHandle {
  relayout: () => void;
  scrollToBottom: () => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
}

interface TerminalControllerHandle {
  flushOutput: () => void;
  setOutputPaused: (value: boolean) => void;
}

export function usePtyView(options: UsePtyViewOptions): UsePtyViewResult {
  const { sessionId, ptyOwner, containerEl, spacerRef, xtermHostRef } = options;

  // === sub-hooks (各自管自己的 state，互不依赖) ===
  const connection = usePtyConnectionState();
  const follow = usePtyFollowState();
  const traceEnabled = usePtyScrollTraceEnabled();
  const { openImagePreview } = useImagePreview();

  // === 私有 ref（仅供 hook 内部使用，不暴露给 JSX）===
  const terminalRef = useRef<Terminal | null>(null);
  const terminalControllerRef = useRef<TerminalControllerHandle | null>(null);
  const scrollControllerRef = useRef<ScrollControllerHandle | null>(null);
  const pendingNewFrameRef = useRef(false);
  const userHasVerticalScrollIntentRef = useRef(false);
  const lastFrameWriteAtRef = useRef<number | null>(null);
  const relayoutSchedulerRef = useRef<RafScheduler | null>(null);
  const rawInputFollowSchedulerRef = useRef<RafScheduler | null>(null);

  // === 视图层状态 ===
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
  const [hasSeenSoftKeyboard, setHasSeenSoftKeyboard] = useState(false);

  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const webOwnsPtyGeometry = ptyOwner === "proxy-hosted";
  const touchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const ptyPlainEnterBehavior = touchEditingSurface ? "linefeed" : "submit";
  const keyboardOffset = useVisualViewportBottomOffset();

  useEffect(() => {
    if (keyboardOffset > 0) setHasSeenSoftKeyboard(true);
  }, [keyboardOffset]);
  const softKeyboardOpenOrUnknown = !hasSeenSoftKeyboard || keyboardOffset > 0;

  const focus = usePtyFocusState({ containerEl, xtermHostRef, terminalRef });
  const { ptyInputFocused, suppressPtyFocus, handleFocusCapture, handleBlurCapture } = focus;
  const showMobilePtyControls =
    touchEditingSurface && ptyInputFocused && softKeyboardOpenOrUnknown;

  const clearNewFramesWhileAway = follow.clearNewFramesWhileAway;

  // === scheduler（首次访问 lazy 创建，组件卸载时清理）===
  if (!relayoutSchedulerRef.current) {
    relayoutSchedulerRef.current = createRafScheduler(() => {
      scrollControllerRef.current?.relayout();
    });
  }
  if (!rawInputFollowSchedulerRef.current) {
    rawInputFollowSchedulerRef.current = createRafScheduler(() => {
      scrollControllerRef.current?.scrollToBottom();
      clearNewFramesWhileAway();
    });
  }

  useEffect(() => {
    return () => {
      relayoutSchedulerRef.current?.dispose();
      rawInputFollowSchedulerRef.current?.dispose();
      relayoutSchedulerRef.current = null;
      rawInputFollowSchedulerRef.current = null;
    };
  }, []);

  const touchGestureHandlers = usePtyTouchGesture({ terminalRef, suppressPtyFocus });

  const handlePasteCapture = useTerminalPaste({
    sessionId,
    terminalRef,
    onAfterPaste: () => rawInputFollowSchedulerRef.current?.schedule(),
  });

  const handleTerminalContainerMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(".xterm")) return;
      // 空白 spacer 区域不是 xterm DOM。浏览器默认 mousedown 会把焦点从 xterm
      // helper textarea 移到 body，导致后续方向键 / Enter 不再进入 PTY。
      event.preventDefault();
      terminalRef.current?.focus();
    },
    [],
  );

  // === 终端层 effect：xterm 实例 / image link / debug 注册 ===
  // 在 onTerminalReady 里完成所有 terminal 衍生 wiring；用 connection.ready 派发给
  // 下游的 scroll/resize effect 走分离生命周期——reconnect 时 socket 重建 ws、xterm
  // 重建，但 scroll-controller 仍旧（持有旧 term 引用，DOM 容器复用）。这样可以
  // 避免 scroll-controller 在 reconnect 瞬间因 spacer 还没长大就 wasAtBottom=true，
  // 触发 scrollToBottom 把用户回看的 intent 清掉的回归。
  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const host = xtermHostRef.current;
    const ws = wsManagerRef;
    const relay = relayClientRef;
    if (!host || !ws || !relay) return;

    let imageLinkDispose: (() => void) | null = null;
    let ptyDebugDeregister: (() => void) | null = null;

    const onFramePending = (): void => {
      pendingNewFrameRef.current = true;
      if (
        userHasVerticalScrollIntentRef.current &&
        !follow.hasNewFramesWhileAwayRef.current
      ) {
        follow.setHasNewFramesWhileAway(true);
      }
    };

    const onFrameWritten = (): void => {
      lastFrameWriteAtRef.current = performance.now();
      relayoutSchedulerRef.current?.schedule();
    };

    const onRawInput = (): void => {
      rawInputFollowSchedulerRef.current?.schedule();
    };

    const termCtrl = attachPtyTerminalController({
      host,
      sessionId,
      ws,
      relay,
      createTerminal: (container) =>
        createXtermTerminal(container, { fontSize: useAppStore.getState().ptyFontSize }),
      attachRawInput: (term, rawSessionId, rawOptions) =>
        attachXtermRawInput(term, rawSessionId, {
          ...rawOptions,
          plainEnterBehavior: ptyPlainEnterBehavior,
        }),
      onTerminalReady: (term) => {
        const xterm = term as Terminal;
        terminalRef.current = xterm;
        imageLinkDispose = registerImagePreviewLinkProvider(xterm, openImagePreview).dispose;
        registerPtySerializer(sessionId, () => serializeTerminalBuffer(xterm));
        registerPtyTerminal(sessionId, xterm);
        registerPtyTerminalWindowAccessor(() => terminalRef.current);
        ptyDebugDeregister = getPtyDebug().registerTerminal(sessionId, {
          // 强制整屏重绘绕过 atlas 缓存——给"鼠标选中后正常显示"这种 cell 残留 bug 用。
          refresh: () => xterm.refresh(0, xterm.rows - 1),
          serialize: () => serializeTerminalBuffer(xterm),
          describe: () => ({ sessionId, cols: xterm.cols, rows: xterm.rows }),
        });
      },
      onFramePending,
      onFrameWritten,
      onRawInput,
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`终端初始化失败：${message}`);
      },
      ...connection.transport,
    });
    terminalControllerRef.current = termCtrl;

    return () => {
      imageLinkDispose?.();
      ptyDebugDeregister?.();
      registerPtySerializer(sessionId, null);
      registerPtyTerminal(sessionId, null);
      unregisterPtyTerminalWindowAccessor();
      termCtrl.dispose();
      terminalRef.current = null;
      terminalControllerRef.current = null;
    };
  }, [
    sessionId,
    connected,
    proxyOnline,
    xtermHostRef,
    connection.transport,
    follow.hasNewFramesWhileAwayRef,
    follow.setHasNewFramesWhileAway,
    ptyPlainEnterBehavior,
    openImagePreview,
  ]);

  // === scroll / resize effect：仅 connection.ready 第一次为 true 时挂载 ===
  // connection.ready 一旦为 true 就不再变 false（usePtyConnectionState 不重置），
  // 所以 reconnect 不会重跑这个 effect——scroll controller 持有的 xterm 引用变 stale，
  // 但容器 DOM 不变；接下来用户的 scrollTop / scrollIntent 状态完整保留。
  useEffect(() => {
    if (!connection.ready) return;
    const container = containerEl;
    const spacer = spacerRef.current;
    const host = xtermHostRef.current;
    const term = terminalRef.current;
    if (!container || !spacer || !host || !term) return;

    const scrollCtrl = attachPtyScrollController({
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
    scrollControllerRef.current = scrollCtrl;

    registerPtyDebugSnapshotProvider(() => ({
      ...buildPtyScrollDebugSnapshot(scrollCtrl.getDebugProbe, {
        container,
        spacer,
        host,
        term,
      }),
      frame: {
        lastWriteAt: lastFrameWriteAtRef.current,
        pendingNewFrame: pendingNewFrameRef.current,
      },
    }));

    let resizeDispose: (() => void) | null = null;
    if (webOwnsPtyGeometry) {
      const relay = relayClientRef;
      if (relay) {
        const resizeCtrl = attachPtyResizeController({
          container,
          term,
          onResize: (cols, rows) => {
            relay.sendControl({ type: "terminal_resize_request", sessionId, cols, rows });
          },
          onRelayout: () => scrollControllerRef.current?.relayout(),
        });
        resizeDispose = resizeCtrl.dispose;
      }
    }

    return () => {
      scrollCtrl.dispose();
      resizeDispose?.();
      unregisterPtyDebugSnapshotProvider();
      scrollControllerRef.current = null;
    };
  }, [
    connection.ready,
    containerEl,
    spacerRef,
    xtermHostRef,
    follow.handleAtBottomChange,
    follow.hasNewFramesWhileAwayRef,
    follow.setHasNewFramesWhileAway,
    suppressPtyFocus,
    webOwnsPtyGeometry,
    sessionId,
  ]);

  // === font-size effect：依赖 ptyFontSize 单独触发 ===
  useEffect(() => {
    const term = terminalRef.current;
    const scroll = scrollControllerRef.current;
    if (!term || !scroll) return;
    applyPtyFontSize(term, ptyFontSize, scroll.relayout);
  }, [ptyFontSize]);

  // === 暴露给 JSX 的命令式句柄（稳定 useCallback，内部读 ref 拿当前 controller）===
  const scrollToBottom = useCallback((): void => {
    scrollControllerRef.current?.scrollToBottom();
  }, []);
  const scrollToRatio = useCallback((ratio: number): void => {
    scrollControllerRef.current?.scrollToRatio(ratio);
  }, []);
  const scrollToXRatio = useCallback((ratio: number): void => {
    scrollControllerRef.current?.scrollToXRatio(ratio);
  }, []);

  const sendMobileInput = useCallback(
    (data: string): void => {
      sendRemoteInputRaw(sessionId, data);
      rawInputFollowSchedulerRef.current?.schedule();
      terminalRef.current?.focus();
    },
    [sessionId],
  );

  const containerPaddingBottom = showMobilePtyControls
    ? 64
    : scrollState.horizontalScrollable
      ? 32
      : 8;

  const focusHandlers = useMemo<FocusHandlers>(
    () => ({
      onFocusCapture: handleFocusCapture,
      onBlurCapture: handleBlurCapture,
    }),
    [handleFocusCapture, handleBlurCapture],
  );

  return {
    scrollState,
    isAtBottom: follow.isAtBottom,
    hasNewFramesWhileAway: follow.hasNewFramesWhileAway,
    ptyInputFocused,
    showMobilePtyControls,
    touchEditingSurface,
    connectionOverlay: connection.overlay,
    containerPaddingBottom,
    traceEnabled,
    scrollToBottom,
    scrollToRatio,
    scrollToXRatio,
    clearNewFramesWhileAway,
    sendMobileInput,
    handleTerminalContainerMouseDown,
    handlePasteCapture,
    pointerHandlers: touchGestureHandlers,
    focusHandlers,
  };
}
