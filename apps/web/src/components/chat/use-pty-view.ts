// PTY 视图编排 hook：把 4 个 controller（terminal / scroll / resize / font-size）
// 的 bringup 顺序、命令式句柄、调试注册、image preview link provider 等横切关注点
// 集中到这里，让 chat-pty-view.tsx 退化为纯 JSX shell。
//
// 关键设计：单一 effect 在 attachPtyTerminalController 的 onTerminalReady 回调里
// 就近挂 scroll/resize/debug——typed handshake（term 直接作为入参传入），跨 effect
// 没有隐式 ref 协议。font-size effect 因为依赖 store 状态独立 trigger 单独保留。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { createXtermTerminal } from "@/lib/create-xterm";
import { applyPtyFontSize } from "@/lib/pty-font-size-controller";
import {
  attachPtyDragSelectAutoscroll,
  type DragSelectDebugSnapshot,
} from "@/lib/pty-drag-select-autoscroll";
import { attachXtermRawInput } from "@/lib/pty-input";
import { attachPtyResizeController } from "@/lib/pty-resize-controller";
import { attachPtyScrollController, type PtyScrollState } from "@/lib/pty-scroll-controller";
import { attachPtyTerminalController } from "@/lib/pty-terminal-controller";
import { registerImagePreviewLinkProvider } from "@/lib/xterm-image-preview-links";
import { registerFileDownloadLinkProvider } from "@/lib/xterm-file-download-links";
import { triggerFileDownload } from "@/lib/file-download-trigger";
import { uploadFileAndShowToast } from "@/lib/file-upload-payload";
import { copyText } from "@/lib/copy-text";
import { toast } from "@/components/toast";
import { getEdgeAutoscrollDelta } from "@/lib/pty-edge-autoscroll";
import { createRafScheduler } from "@/lib/raf-scheduler";
import type { RafScheduler } from "@/lib/raf-scheduler";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { computePtySelectionToolbarPosition } from "@/lib/pty-selection-overlay-position";
import {
  registerPtyDebugSnapshotProvider,
  registerPtyTerminalWindowAccessor,
  unregisterPtyDebugSnapshotProvider,
  unregisterPtyTerminalWindowAccessor,
} from "@/lib/pty-debug-snapshot";
import { buildPtyScrollDebugSnapshot } from "@/lib/pty-scroll-debug-snapshot";
import { getPtyDebug } from "@/lib/pty-render-debug";
import {
  clearRenderModel,
  diffModelAgainstBuffer,
  probeWebglRenderModel,
} from "@/lib/pty-render-state-probe";
import { serializeTerminalBuffer } from "@/lib/pty-serialize-buffer";
import {
  getClientPositionForTerminalPoint,
  getTerminalPointAtClient,
  selectTerminalInitialRangeAtPoint,
  selectTerminalRange,
  type TerminalSelectionPoint,
} from "@/lib/pty-line-selection";
import { registerPtyLinkProvider, registerPtySerializer, registerPtyTerminal } from "@/test-hooks";
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
  active?: boolean;
  containerEl: HTMLDivElement | null;
  spacerRef: RefObject<HTMLDivElement | null>;
  xtermHostRef: RefObject<HTMLDivElement | null>;
}

interface PointerHandlers {
  onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onTouchStartCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchMoveCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchEndCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchCancelCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
}

interface FocusHandlers {
  onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => void;
  onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => void;
}

type PtySelectionHandleKind = "anchor" | "focus";

interface PtySelectionHandlePosition {
  left: number;
  top: number;
}

interface PtySelectionHandles {
  anchor: PtySelectionHandlePosition;
  focus: PtySelectionHandlePosition;
}

interface PtySelectionHandleMetrics {
  visualSize: number;
  stemSize: number;
  touchSize: number;
}

interface UsePtyViewResult {
  scrollState: PtyScrollState;
  isAtBottom: boolean;
  hasNewFramesWhileAway: boolean;
  ptyInputFocused: boolean;
  showMobilePtyControls: boolean;
  touchEditingSurface: boolean;
  connectionOverlay: { connecting: boolean; subscribeDelayed: boolean };
  containerPaddingBottom: number;
  traceEnabled: boolean;
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  clearNewFramesWhileAway: () => void;
  sendMobileInput: (data: string) => void;
  pasteMobileClipboard: () => void;
  handleTerminalContainerMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  handlePasteCapture: (event: ClipboardEvent<HTMLDivElement>) => void;
  pointerHandlers: PointerHandlers;
  focusHandlers: FocusHandlers;
  ptySelectionToolbar: { left: number; top: number } | null;
  ptySelectionHandles: PtySelectionHandles | null;
  ptySelectionHandleMetrics: PtySelectionHandleMetrics;
  copyPtySelection: () => void;
  handlePtySelectionHandlePointerDown: (
    kind: PtySelectionHandleKind,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  handlePtySelectionHandleTouchStart: (
    kind: PtySelectionHandleKind,
    event: ReactTouchEvent<HTMLElement>,
  ) => void;
  isPtyDragOver: boolean;
  handlePtyDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  handlePtyDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  handlePtyDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
}

interface ScrollControllerHandle {
  relayout: () => void;
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  traceRawInputFollowScheduled: (source?: string) => void;
  traceRawInputFollowFire: () => void;
}

interface TerminalControllerHandle {
  flushOutput: () => void;
  setOutputPaused: (value: boolean) => void;
}

export function usePtyView(options: UsePtyViewOptions): UsePtyViewResult {
  const { sessionId, ptyOwner, active = true, containerEl, spacerRef, xtermHostRef } = options;

  // === sub-hooks (各自管自己的 state，互不依赖) ===
  const connection = usePtyConnectionState();
  const follow = usePtyFollowState();
  const traceEnabled = usePtyScrollTraceEnabled();
  const { openImagePreview } = useImagePreview();

  // === 私有 ref（仅供 hook 内部使用，不暴露给 JSX）===
  const terminalRef = useRef<Terminal | null>(null);
  const terminalControllerRef = useRef<TerminalControllerHandle | null>(null);
  const scrollControllerRef = useRef<ScrollControllerHandle | null>(null);
  const activeRef = useRef(active);
  const readyRef = useRef(false);
  const pendingNewFrameRef = useRef(false);
  const userHasVerticalScrollIntentRef = useRef(false);
  const lastFrameWriteAtRef = useRef<number | null>(null);
  const relayoutSchedulerRef = useRef<RafScheduler | null>(null);
  const rawInputFollowSchedulerRef = useRef<RafScheduler | null>(null);
  const keyboardFollowStateRef = useRef({ keyboardOpen: false, controlsVisible: false });
  const mobileLayoutDebugRef = useRef({
    keyboardOffset: 0,
    hasSeenSoftKeyboard: false,
    showMobilePtyControls: false,
    touchEditingSurface: false,
    ptyInputFocused: false,
    containerPaddingBottom: 0,
  });
  // attachPtyDragSelectAutoscroll 在 onTerminalReady 内部 attach 而 registerTerminal
  // 在它之前发生, 用 ref 把 snapshot 取数函数传给 debug API。
  const dragSelectSnapshotRef = useRef<(() => DragSelectDebugSnapshot) | null>(null);

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
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    readyRef.current = connection.ready;
  }, [connection.ready]);

  const canAcceptInput = useCallback((): boolean => {
    return activeRef.current && readyRef.current;
  }, []);

  useEffect(() => {
    if (keyboardOffset > 0) setHasSeenSoftKeyboard(true);
  }, [keyboardOffset]);
  const softKeyboardOpenOrUnknown = !hasSeenSoftKeyboard || keyboardOffset > 0;

  const focus = usePtyFocusState({ containerEl, xtermHostRef, terminalRef });
  const { ptyInputFocused, suppressPtyFocus, handleFocusCapture, handleBlurCapture } = focus;
  const showMobilePtyControls = touchEditingSurface && ptyInputFocused && softKeyboardOpenOrUnknown;

  mobileLayoutDebugRef.current = {
    keyboardOffset,
    hasSeenSoftKeyboard,
    showMobilePtyControls,
    touchEditingSurface,
    ptyInputFocused,
    containerPaddingBottom: mobileLayoutDebugRef.current.containerPaddingBottom,
  };

  const clearNewFramesWhileAway = follow.clearNewFramesWhileAway;

  // === scheduler（首次访问 lazy 创建，组件卸载时清理）===
  if (!relayoutSchedulerRef.current) {
    relayoutSchedulerRef.current = createRafScheduler(() => {
      scrollControllerRef.current?.relayout();
    });
  }
  if (!rawInputFollowSchedulerRef.current) {
    rawInputFollowSchedulerRef.current = createRafScheduler(() => {
      scrollControllerRef.current?.traceRawInputFollowFire();
      scrollControllerRef.current?.scrollToBottom("rawInput");
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

  const scheduleRawInputFollow = useCallback((source: string = "rawInput"): void => {
    scrollControllerRef.current?.traceRawInputFollowScheduled(source);
    rawInputFollowSchedulerRef.current?.schedule();
  }, []);

  const selectionAnchorRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionFocusRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionDraggedRef = useRef(false);
  const selectedPtyTextRef = useRef("");
  const selectionAutoscrollFrameRef = useRef<number | null>(null);
  const selectionAutoscrollPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const selectionSuppressNativeTouchScrollRef = useRef(false);
  const selectionDragHandleRef = useRef<PtySelectionHandleKind | null>(null);
  const selectionHandleDragCleanupRef = useRef<(() => void) | null>(null);
  const [ptySelectionToolbar, setPtySelectionToolbar] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [ptySelectionHandles, setPtySelectionHandles] = useState<PtySelectionHandles | null>(null);
  const ptySelectionHandleMetrics = useMemo<PtySelectionHandleMetrics>(
    () => ({
      visualSize: Math.round(Math.min(12, Math.max(8, ptyFontSize * 0.55))),
      stemSize: Math.round(Math.min(11, Math.max(7, ptyFontSize * 0.5))),
      touchSize: 44,
    }),
    [ptyFontSize],
  );

  const getToolbarPosition = useCallback((clientX: number, clientY: number): { left: number; top: number } => {
    const visualViewport = window.visualViewport;
    return computePtySelectionToolbarPosition({
      clientX,
      clientY,
      viewportWidth: visualViewport?.width ?? window.innerWidth,
      viewportHeight: visualViewport?.height ?? window.innerHeight,
      viewportOffsetLeft: visualViewport?.offsetLeft ?? 0,
      viewportOffsetTop: visualViewport?.offsetTop ?? 0,
    });
  }, []);

  const stopPtySelectionAutoscroll = useCallback((): void => {
    selectionAutoscrollPointRef.current = null;
    selectionSuppressNativeTouchScrollRef.current = false;
    selectionDragHandleRef.current = null;
    if (selectionAutoscrollFrameRef.current === null) return;
    cancelAnimationFrame(selectionAutoscrollFrameRef.current);
    selectionAutoscrollFrameRef.current = null;
  }, []);

  const getSelectionHandles = useCallback(
    (anchor: TerminalSelectionPoint, focus: TerminalSelectionPoint): PtySelectionHandles | null => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return null;
      const anchorPosition = getClientPositionForTerminalPoint({
        terminal,
        host,
        point: anchor,
        affinity: "before",
      });
      const focusPosition = getClientPositionForTerminalPoint({
        terminal,
        host,
        point: focus,
        affinity: "after",
      });
      if (!anchorPosition || !focusPosition) return null;
      return { anchor: anchorPosition, focus: focusPosition };
    },
    [xtermHostRef],
  );

  const refreshSelectionHandles = useCallback((): void => {
    const anchor = selectionAnchorRef.current;
    const focusPoint = selectionFocusRef.current;
    if (!anchor || !focusPoint) {
      setPtySelectionHandles(null);
      return;
    }
    const handles = getSelectionHandles(anchor, focusPoint);
    setPtySelectionHandles(handles);
    if (!handles) setPtySelectionToolbar(null);
  }, [getSelectionHandles]);

  const clearPtySelection = useCallback((): void => {
    selectionHandleDragCleanupRef.current?.();
    selectionHandleDragCleanupRef.current = null;
    stopPtySelectionAutoscroll();
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    selectionDraggedRef.current = false;
    selectedPtyTextRef.current = "";
    terminalRef.current?.clearSelection();
    setPtySelectionToolbar(null);
    setPtySelectionHandles(null);
  }, [stopPtySelectionAutoscroll]);

  const applyPtySelectionRange = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }) => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      const anchor = selectionAnchorRef.current;
      const focusPoint = selectionFocusRef.current;
      if (!terminal || !host || !anchor) return null;
      const focus = getTerminalPointAtClient({ terminal, host, clientX, clientY });
      if (!focus) return null;
      const draggedHandle = selectionDragHandleRef.current ?? "focus";
      const nextAnchor = draggedHandle === "anchor" ? focus : anchor;
      const nextFocus = draggedHandle === "focus" ? focus : (focusPoint ?? anchor);
      selectionAnchorRef.current = nextAnchor;
      selectionFocusRef.current = nextFocus;
      selectionDraggedRef.current = true;
      const selected = selectTerminalRange({ terminal, anchor: nextAnchor, focus: nextFocus });
      selectedPtyTextRef.current = selected?.text ?? "";
      setPtySelectionHandles(selected ? getSelectionHandles(nextAnchor, nextFocus) : null);
      return selected;
    },
    [getSelectionHandles, xtermHostRef],
  );

  const runPtySelectionAutoscroll = useCallback((): void => {
    selectionAutoscrollFrameRef.current = null;
    const point = selectionAutoscrollPointRef.current;
    if (!point || !containerEl || !selectionAnchorRef.current) return;

    const rect = containerEl.getBoundingClientRect();
    const { dx, dy } = getEdgeAutoscrollDelta({
      pointerX: point.clientX,
      pointerY: point.clientY,
      rect,
      scrollLeft: containerEl.scrollLeft,
      scrollTop: containerEl.scrollTop,
      scrollWidth: containerEl.scrollWidth,
      scrollHeight: containerEl.scrollHeight,
      clientWidth: containerEl.clientWidth,
      clientHeight: containerEl.clientHeight,
      edgePx: 44,
      maxSpeedPx: 18,
    });

    if (dx !== 0) containerEl.scrollLeft += dx;
    if (dy !== 0) containerEl.scrollTop += dy;
    if (dx !== 0 || dy !== 0) applyPtySelectionRange(point);

    selectionAutoscrollFrameRef.current = requestAnimationFrame(runPtySelectionAutoscroll);
  }, [applyPtySelectionRange, containerEl]);

  const updatePtySelectionAutoscroll = useCallback(
    (point: { clientX: number; clientY: number }): void => {
      selectionAutoscrollPointRef.current = point;
      if (selectionAutoscrollFrameRef.current !== null) return;
      selectionAutoscrollFrameRef.current = requestAnimationFrame(runPtySelectionAutoscroll);
    },
    [runPtySelectionAutoscroll],
  );

  useEffect(() => stopPtySelectionAutoscroll, [stopPtySelectionAutoscroll]);

  useEffect(() => {
    if (!containerEl) return;
    const suppressNativeScroll = (event: TouchEvent): void => {
      if (!selectionSuppressNativeTouchScrollRef.current) return;
      event.preventDefault();
    };
    containerEl.addEventListener("touchmove", suppressNativeScroll, {
      capture: true,
      passive: false,
    });
    return () => {
      containerEl.removeEventListener("touchmove", suppressNativeScroll, {
        capture: true,
      });
    };
  }, [containerEl]);

  useEffect(() => {
    if (!ptySelectionToolbar && !ptySelectionHandles) return;
    const clearUnlessSelectionControl = (event: Event): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-slot="pty-selection-toolbar"], [data-slot="pty-selection-handle"]')
      ) {
        return;
      }
      clearPtySelection();
    };
    document.addEventListener("pointerdown", clearUnlessSelectionControl, true);
    document.addEventListener("touchstart", clearUnlessSelectionControl, true);
    return () => {
      document.removeEventListener("pointerdown", clearUnlessSelectionControl, true);
      document.removeEventListener("touchstart", clearUnlessSelectionControl, true);
    };
  }, [clearPtySelection, ptySelectionHandles, ptySelectionToolbar]);

  const hasPtySelectionHandles = ptySelectionHandles !== null;
  useEffect(() => {
    if (!hasPtySelectionHandles) return;
    refreshSelectionHandles();
  }, [hasPtySelectionHandles, refreshSelectionHandles, scrollState.scrollLeft, scrollState.scrollTop]);

  const handlePtyLongPressStart = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      stopPtySelectionAutoscroll();
      selectionSuppressNativeTouchScrollRef.current = true;
      selectionDragHandleRef.current = "focus";
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return;
      const point = getTerminalPointAtClient({ terminal, host, clientX, clientY });
      terminal.clearSelection();
      if (!point) {
        selectionAnchorRef.current = null;
        selectionFocusRef.current = null;
        selectedPtyTextRef.current = "";
        setPtySelectionToolbar(null);
        setPtySelectionHandles(null);
        return;
      }
      selectionAnchorRef.current = point;
      selectionFocusRef.current = point;
      selectionDraggedRef.current = false;
      selectedPtyTextRef.current = "";
      setPtySelectionToolbar(null);
      setPtySelectionHandles(null);
    },
    [stopPtySelectionAutoscroll, xtermHostRef],
  );

  const handlePtyLongPressMove = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      selectionDragHandleRef.current = "focus";
      applyPtySelectionRange({ clientX, clientY });
      updatePtySelectionAutoscroll({ clientX, clientY });
      setPtySelectionToolbar(null);
    },
    [applyPtySelectionRange, updatePtySelectionAutoscroll],
  );

  const handlePtyLongPressEnd = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      stopPtySelectionAutoscroll();
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return;

      const anchor = selectionAnchorRef.current;
      const focus = getTerminalPointAtClient({ terminal, host, clientX, clientY }) ?? selectionFocusRef.current;
      const selected =
        selectionDraggedRef.current && anchor && focus
          ? selectTerminalRange({ terminal, anchor, focus })
          : selectTerminalInitialRangeAtPoint({ terminal, host, clientX, clientY });
      if (!selected?.text) {
        clearPtySelection();
        return;
      }

      selectionAnchorRef.current = selected.anchor;
      selectionFocusRef.current = selected.focus;
      selectedPtyTextRef.current = selected.text;
      setPtySelectionHandles(getSelectionHandles(selected.anchor, selected.focus));
      setPtySelectionToolbar(getToolbarPosition(clientX, clientY));
    },
    [clearPtySelection, getSelectionHandles, getToolbarPosition, stopPtySelectionAutoscroll, xtermHostRef],
  );

  const copyPtySelection = useCallback((): void => {
    const terminal = terminalRef.current;
    const selected = terminal?.getSelection?.() || selectedPtyTextRef.current;
    if (!selected) return;

    void copyText(selected).then((result) => {
      clearPtySelection();
      if (result === "failed") toast.error("复制失败");
    });
  }, [clearPtySelection]);

  const handlePtySelectionHandlePointerDown = useCallback(
    (kind: PtySelectionHandleKind, event: ReactPointerEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      selectionHandleDragCleanupRef.current?.();
      selectionDragHandleRef.current = kind;
      selectionSuppressNativeTouchScrollRef.current = true;
      setPtySelectionToolbar(null);

      let cleanup = (): void => {};
      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.cancelable) moveEvent.preventDefault();
        const point = { clientX: moveEvent.clientX, clientY: moveEvent.clientY };
        applyPtySelectionRange(point);
        updatePtySelectionAutoscroll(point);
      };
      const finish = (finishEvent: PointerEvent): void => {
        const point = { clientX: finishEvent.clientX, clientY: finishEvent.clientY };
        applyPtySelectionRange(point);
        cleanup();
        selectionHandleDragCleanupRef.current = null;
        stopPtySelectionAutoscroll();
        if (selectedPtyTextRef.current) setPtySelectionToolbar(getToolbarPosition(point.clientX, point.clientY));
      };
      const cancel = (): void => {
        cleanup();
        selectionHandleDragCleanupRef.current = null;
        stopPtySelectionAutoscroll();
      };
      cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
      };
      selectionHandleDragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish, { once: true });
      window.addEventListener("pointercancel", cancel, { once: true });
    },
    [applyPtySelectionRange, getToolbarPosition, stopPtySelectionAutoscroll, updatePtySelectionAutoscroll],
  );

  const handlePtySelectionHandleTouchStart = useCallback(
    (kind: PtySelectionHandleKind, event: ReactTouchEvent<HTMLElement>): void => {
      if (selectionHandleDragCleanupRef.current) return;
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) return;
      event.preventDefault();
      event.stopPropagation();
      selectionDragHandleRef.current = kind;
      selectionSuppressNativeTouchScrollRef.current = true;
      setPtySelectionToolbar(null);

      let cleanup = (): void => {};
      const move = (moveEvent: TouchEvent): void => {
        const nextTouch = moveEvent.touches[0] ?? moveEvent.changedTouches[0];
        if (!nextTouch) return;
        if (moveEvent.cancelable) moveEvent.preventDefault();
        const point = { clientX: nextTouch.clientX, clientY: nextTouch.clientY };
        applyPtySelectionRange(point);
        updatePtySelectionAutoscroll(point);
      };
      const finish = (finishEvent: TouchEvent): void => {
        const endTouch = finishEvent.changedTouches[0];
        const point = endTouch
          ? { clientX: endTouch.clientX, clientY: endTouch.clientY }
          : selectionAutoscrollPointRef.current;
        if (point) applyPtySelectionRange(point);
        cleanup();
        selectionHandleDragCleanupRef.current = null;
        stopPtySelectionAutoscroll();
        if (point && selectedPtyTextRef.current) {
          setPtySelectionToolbar(getToolbarPosition(point.clientX, point.clientY));
        }
      };
      const cancel = (): void => {
        cleanup();
        selectionHandleDragCleanupRef.current = null;
        stopPtySelectionAutoscroll();
      };
      cleanup = () => {
        window.removeEventListener("touchmove", move);
        window.removeEventListener("touchend", finish);
        window.removeEventListener("touchcancel", cancel);
      };
      selectionHandleDragCleanupRef.current = cleanup;
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", finish, { once: true });
      window.addEventListener("touchcancel", cancel, { once: true });
    },
    [applyPtySelectionRange, getToolbarPosition, stopPtySelectionAutoscroll, updatePtySelectionAutoscroll],
  );

  const touchGestureHandlers = usePtyTouchGesture({
    terminalRef,
    suppressPtyFocus,
    onLongPressStart: handlePtyLongPressStart,
    onLongPressMove: handlePtyLongPressMove,
    onLongPressEnd: handlePtyLongPressEnd,
  });

  const handleTerminalPasteCapture = useTerminalPaste({
    sessionId,
    terminalRef,
    onAfterPaste: () => scheduleRawInputFollow("paste"),
  });
  const handlePasteCapture = useCallback(
    (event: ClipboardEvent<HTMLDivElement>): void => {
      if (!canAcceptInput()) {
        event.preventDefault();
        return;
      }
      handleTerminalPasteCapture(event);
    },
    [canAcceptInput, handleTerminalPasteCapture],
  );

  // 拖拽任意文件到终端容器: 上传后把 "@<path> " 写到 PTY stdin, 与 chat-header
  // upload menu 同样形状。dragover 必须 preventDefault 否则浏览器拒绝触发 drop。
  const [isPtyDragOver, setIsPtyDragOver] = useState(false);
  const handlePtyDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsPtyDragOver((current) => (current ? current : true));
  }, []);
  const handlePtyDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsPtyDragOver(false);
  }, []);
  const handlePtyDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>): Promise<void> => {
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      event.preventDefault();
      setIsPtyDragOver(false);
      if (!canAcceptInput()) return;
      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }
      const path = await uploadFileAndShowToast({ relay, sessionId, file });
      if (path) sendRemoteInputRaw(sessionId, `@${path} `);
    },
    [canAcceptInput, sessionId],
  );

  const handleTerminalContainerMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (!canAcceptInput()) {
        event.preventDefault();
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest(".xterm")) return;
      // 空白 spacer 区域不是 xterm DOM。浏览器默认 mousedown 会把焦点从 xterm
      // helper textarea 移到 body，导致后续方向键 / Enter 不再进入 PTY。
      event.preventDefault();
      terminalRef.current?.focus();
    },
    [canAcceptInput],
  );

  // === controller graph：单 effect 编排 terminal / scroll / resize ===
  // attachPtyTerminalController 的 onTerminalReady 是 typed handshake：term 在 callback
  // 入参里直接给到，不再依赖 React 重渲染让下游 effect 通过 ref 读到。所有 terminal
  // 衍生 wiring（image link / debug 注册 / scroll-controller / resize-controller）
  // 都在这个 callback 内一并挂载。reconnect 时 termCtrl/scrollCtrl 一起重建——靠
  // userHasVerticalScrollIntentRef 跨周期保留用户回看意图，且 scroll-controller 内部
  // 对 wasAtBottom 的判定已修正（updateSpacer 之后再读 scrollHeight），不会因 spacer
  // 几何 stale 误判 atBottom 而清掉 intent。
  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const host = xtermHostRef.current;
    const ws = wsManagerRef;
    const relay = relayClientRef;
    const container = containerEl;
    const spacer = spacerRef.current;
    if (!host || !ws || !relay || !container || !spacer) return;

    let imageLinkDispose: (() => void) | null = null;
    let fileDownloadLinkDispose: (() => void) | null = null;
    let ptyDebugDeregister: (() => void) | null = null;
    let scrollDispose: (() => void) | null = null;
    let resizeDispose: (() => void) | null = null;
    let dragSelectDispose: (() => void) | null = null;

    const onFramePending = (): void => {
      pendingNewFrameRef.current = true;
      if (userHasVerticalScrollIntentRef.current && !follow.hasNewFramesWhileAwayRef.current) {
        follow.setHasNewFramesWhileAway(true);
      }
    };

    const onFrameWritten = (): void => {
      lastFrameWriteAtRef.current = performance.now();
      relayoutSchedulerRef.current?.schedule();
    };

    const onRawInput = (): void => {
      scheduleRawInputFollow("rawInput");
    };

    let getWebglAddon: (() => Parameters<typeof probeWebglRenderModel>[0] | null) | null = null;

    const termCtrl = attachPtyTerminalController({
      host,
      sessionId,
      ws,
      relay,
      // 触屏设备进入会话时不自动聚焦 xterm helper textarea, 否则 Android/iOS 立刻起 IME 把
      // 视口压成一半, 用户还没看清当前 PTY 内容键盘已遮; 桌面保留 RAF auto-focus。
      // 用户想敲字仍可点 PTY 区域 (handleTerminalContainerMouseDown / pointerdown 都挂了
      // terminal.focus)。
      scheduleAutoFocus: touchEditingSurface ? () => {} : undefined,
      createTerminal: async (terminalHost) => {
        const result = await createXtermTerminal(terminalHost, {
          fontSize: useAppStore.getState().ptyFontSize,
        });
        // 暴露给后续 onTerminalReady 注册 dumpRenderDiff——靠形状探测拿 model.cells。
        getWebglAddon = () => result.getWebglAddon();
        return result;
      },
      attachRawInput: (term, rawSessionId, rawOptions) =>
        attachXtermRawInput(term, rawSessionId, {
          ...rawOptions,
          plainEnterBehavior: ptyPlainEnterBehavior,
        }),
      isInputEnabled: canAcceptInput,
      canFocus: canAcceptInput,
      onTerminalReady: (term) => {
        const xterm = term as Terminal;
        terminalRef.current = xterm;
        const imageLinkRegistration = registerImagePreviewLinkProvider(xterm, openImagePreview);
        imageLinkDispose = imageLinkRegistration.dispose;
        registerPtyLinkProvider(sessionId, "image-preview", imageLinkRegistration.provider);
        const fileDownloadLinkRegistration = registerFileDownloadLinkProvider(
          xterm,
          async (path) => {
            const toastId = toast.loading(`下载 ${path} ...`);
            try {
              const result = await triggerFileDownload({ relay, sessionId, path });
              if (result.ok) toast.success(`已下载 ${path}`, { id: toastId });
              else toast.error(result.error, { id: toastId });
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
            }
          },
        );
        fileDownloadLinkDispose = fileDownloadLinkRegistration.dispose;
        registerPtyLinkProvider(sessionId, "file-download", fileDownloadLinkRegistration.provider);
        registerPtySerializer(sessionId, () => serializeTerminalBuffer(xterm));
        registerPtyTerminal(sessionId, xterm);
        registerPtyTerminalWindowAccessor(() => terminalRef.current);
        ptyDebugDeregister = getPtyDebug().registerTerminal(sessionId, {
          dumpRenderDiff: () => {
            const addon = getWebglAddon?.();
            if (!addon) return null;
            const probed = probeWebglRenderModel(addon, xterm.cols, xterm.rows);
            if (!probed) return null;
            return diffModelAgainstBuffer(xterm, probed);
          },
          clearRenderModel: () => {
            const addon = getWebglAddon?.();
            if (!addon) return false;
            const probed = probeWebglRenderModel(addon, xterm.cols, xterm.rows);
            if (!probed) return false;
            clearRenderModel(probed);
            xterm.refresh(0, xterm.rows - 1);
            return true;
          },
          getDragSelectSnapshot: () => dragSelectSnapshotRef.current?.() ?? null,
        });

        const scrollCtrl = attachPtyScrollController({
          container,
          spacer,
          host,
          term: xterm,
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
          onTouchBoundaryPrevent: suppressPtyFocus,
        });
        scrollControllerRef.current = scrollCtrl;
        scrollDispose = scrollCtrl.dispose;

        registerPtyDebugSnapshotProvider(() => {
          const rectOf = (el: Element | null) => {
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {
              top: rect.top,
              bottom: rect.bottom,
              height: rect.height,
              left: rect.left,
              right: rect.right,
              width: rect.width,
            };
          };
          const controls = document.querySelector('[data-slot="pty-mobile-controls"]');
          const chatRoot = document.querySelector("[data-keyboard-offset]");
          const visualViewport = window.visualViewport;
          const controlsRect = rectOf(controls);
          const visualBottom = visualViewport?.height ?? window.innerHeight;
          return {
            ...buildPtyScrollDebugSnapshot(scrollCtrl.getDebugProbe, {
              container,
              spacer,
              host,
              term: xterm,
            }),
            mobileLayout: {
              ...mobileLayoutDebugRef.current,
              window: {
                innerHeight: window.innerHeight,
                outerHeight: window.outerHeight,
                documentClientHeight: document.documentElement.clientHeight,
              },
              visualViewport: visualViewport
                ? {
                    height: visualViewport.height,
                    width: visualViewport.width,
                    offsetTop: visualViewport.offsetTop,
                    pageTop: visualViewport.pageTop,
                    scale: visualViewport.scale,
                  }
                : null,
              chatRoot: {
                dataKeyboardOffset: chatRoot?.getAttribute("data-keyboard-offset") ?? null,
                rect: rectOf(chatRoot),
              },
              ptyViewRect: rectOf(container.parentElement),
              containerRect: rectOf(container),
              controlsRect,
              controlsOverflowBelowVisualViewport:
                controlsRect === null ? null : controlsRect.bottom - visualBottom,
              activeElement:
                document.activeElement instanceof HTMLElement
                  ? {
                      tag: document.activeElement.tagName,
                      ariaLabel: document.activeElement.getAttribute("aria-label"),
                      slot: document.activeElement
                        .closest("[data-slot]")
                        ?.getAttribute("data-slot"),
                    }
                  : null,
            },
            frame: {
              lastWriteAt: lastFrameWriteAtRef.current,
              pendingNewFrame: pendingNewFrameRef.current,
            },
          };
        });

        const dragSelect = attachPtyDragSelectAutoscroll({ container, host });
        dragSelectDispose = dragSelect.dispose;
        dragSelectSnapshotRef.current = dragSelect.getDebugSnapshot;

        if (webOwnsPtyGeometry) {
          const resizeCtrl = attachPtyResizeController({
            container,
            term: xterm,
            onResize: (cols, rows) => {
              relay.sendControl({ type: "terminal_resize_request", sessionId, cols, rows });
            },
            onRelayout: () => scrollControllerRef.current?.relayout(),
          });
          resizeDispose = resizeCtrl.dispose;
        }
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
      resizeDispose?.();
      dragSelectDispose?.();
      dragSelectSnapshotRef.current = null;
      scrollDispose?.();
      unregisterPtyDebugSnapshotProvider();
      imageLinkDispose?.();
      fileDownloadLinkDispose?.();
      registerPtyLinkProvider(sessionId, "image-preview", null);
      registerPtyLinkProvider(sessionId, "file-download", null);
      ptyDebugDeregister?.();
      registerPtySerializer(sessionId, null);
      registerPtyTerminal(sessionId, null);
      unregisterPtyTerminalWindowAccessor();
      termCtrl.dispose();
      terminalRef.current = null;
      scrollControllerRef.current = null;
      terminalControllerRef.current = null;
    };
    // 故意只列 follow.handleAtBottomChange / .hasNewFramesWhileAwayRef /
    // .setHasNewFramesWhileAway 三个子字段而不是整个 follow 对象。
    //
    // usePtyFollowState 每次都返回一个新对象字面量, follow 的 === 引用每次父级
    // re-render 都不相等; 真把 follow 列进 deps 会让本 effect 每次父 render 都
    // tear down + rebuild xterm Terminal / scroll-controller / resize-controller,
    // 极贵且闪屏。
    //
    // 子字段反过来是 useCallback / RefObject / useState setter, React 保证引用
    // 稳定, 列子字段才是真正的"effect 何时该重跑"。lint 规则机械化, 不识别这种
    // sub-field stability 模式, 因此 disable。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionId,
    connected,
    proxyOnline,
    containerEl,
    spacerRef,
    xtermHostRef,
    connection.transport,
    follow.handleAtBottomChange,
    follow.hasNewFramesWhileAwayRef,
    follow.setHasNewFramesWhileAway,
    ptyPlainEnterBehavior,
    canAcceptInput,
    openImagePreview,
    suppressPtyFocus,
    scheduleRawInputFollow,
    webOwnsPtyGeometry,
  ]);

  // === font-size effect：依赖 ptyFontSize 单独触发 ===
  useEffect(() => {
    const term = terminalRef.current;
    const scroll = scrollControllerRef.current;
    if (!term || !scroll) return;
    applyPtyFontSize(term, ptyFontSize, scroll.relayout);
  }, [ptyFontSize]);

  useEffect(() => {
    if (!active || !connection.ready || touchEditingSurface) return;
    const id = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [active, connection.ready, touchEditingSurface]);

  // === 暴露给 JSX 的命令式句柄（稳定 useCallback，内部读 ref 拿当前 controller）===
  // reason 默认 "viewExternal" — 当 BackToBottom 按钮等明确入口外调时, caller 可传具体 label。
  const scrollToBottom = useCallback(
    (reason: string = "viewExternal", opts?: { force?: boolean }): void => {
      scrollControllerRef.current?.scrollToBottom(reason, opts);
    },
    [],
  );
  const scrollToRatio = useCallback((ratio: number): void => {
    scrollControllerRef.current?.scrollToRatio(ratio);
  }, []);
  const scrollToXRatio = useCallback((ratio: number): void => {
    scrollControllerRef.current?.scrollToXRatio(ratio);
  }, []);

  const sendMobileInput = useCallback(
    (data: string): void => {
      if (!canAcceptInput()) return;
      sendRemoteInputRaw(sessionId, data);
      scheduleRawInputFollow("mobileControl");
      terminalRef.current?.focus();
    },
    [canAcceptInput, scheduleRawInputFollow, sessionId],
  );

  const pasteMobileClipboard = useCallback((): void => {
    if (!canAcceptInput()) return;
    const readText = navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (!window.isSecureContext || !readText) {
      toast.error("无法读取剪贴板");
      terminalRef.current?.focus();
      return;
    }

    void readText()
      .then((text) => {
        if (!text) return;
        sendRemoteInputRaw(sessionId, text);
        scheduleRawInputFollow("paste");
      })
      .catch((err: unknown) => {
        const message = err instanceof Error && err.message ? err.message : "无法读取剪贴板";
        toast.error(message);
      })
      .finally(() => terminalRef.current?.focus());
  }, [canAcceptInput, scheduleRawInputFollow, sessionId]);

  // 移动端 PTY 控制条 2 行高: container py-1.5 (12) + 2 × h-11 (88) + grid gap-1 (4)
  // + border-t (1) ≈ 105px, 留 7px buffer 对齐 BackToBottom 7rem 偏移。
  const containerPaddingBottom = showMobilePtyControls
    ? 112
    : scrollState.horizontalScrollable
      ? 32
      : 8;
  mobileLayoutDebugRef.current.containerPaddingBottom = containerPaddingBottom;

  useEffect(() => {
    relayoutSchedulerRef.current?.schedule();
    const keyboardOpen = keyboardOffset > 0;
    const previous = keyboardFollowStateRef.current;
    const shouldForceKeyboardFollow =
      showMobilePtyControls &&
      keyboardOpen &&
      (!previous.keyboardOpen || !previous.controlsVisible);
    keyboardFollowStateRef.current = {
      keyboardOpen,
      controlsVisible: showMobilePtyControls,
    };
    if (showMobilePtyControls) {
      if (shouldForceKeyboardFollow) {
        scrollControllerRef.current?.scrollToBottom("keyboardOffset", { force: true });
        clearNewFramesWhileAway();
      } else if (!keyboardOpen) {
        scheduleRawInputFollow("keyboardOffset");
      }
    }
  }, [
    keyboardOffset,
    showMobilePtyControls,
    containerPaddingBottom,
    clearNewFramesWhileAway,
    scheduleRawInputFollow,
  ]);

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
    pasteMobileClipboard,
    handleTerminalContainerMouseDown,
    handlePasteCapture,
    pointerHandlers: touchGestureHandlers,
    focusHandlers,
    ptySelectionToolbar,
    ptySelectionHandles,
    ptySelectionHandleMetrics,
    copyPtySelection,
    handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart,
    isPtyDragOver,
    handlePtyDragOver,
    handlePtyDragLeave,
    handlePtyDrop,
  };
}
