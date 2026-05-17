import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { getEdgeAutoscrollDelta } from "@/lib/pty-edge-autoscroll";
import {
  getClientPositionForTerminalPoint,
  getTerminalPointAtClient,
  selectTerminalInitialRangeAtBufferPoint,
  selectTerminalInitialRangeAtPoint,
  selectTerminalRange,
  type TerminalSelectionPoint,
} from "@/lib/pty-line-selection";
import { computeScrollAnchor } from "@/lib/pty-scroll";
import type { PtyScrollDebugProbe } from "@/lib/pty-scroll-debug-snapshot";
import { computePtySelectionToolbarPosition } from "@/lib/pty-selection-overlay-position";
import { usePtyTouchGesture } from "./use-pty-touch-gesture";

export type PtySelectionHandleKind = "anchor" | "focus";

export interface PtySelectionHandlePosition {
  left: number;
  top: number;
}

export interface PtySelectionHandles {
  anchor: PtySelectionHandlePosition;
  focus: PtySelectionHandlePosition;
}

export interface PtySelectionHandleMetrics {
  visualSize: number;
  stemSize: number;
  touchSize: number;
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

interface SelectionScrollControllerHandle {
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
  getDebugProbe: () => PtyScrollDebugProbe;
}

interface UsePtySelectionControllerOptions {
  terminalRef: RefObject<Terminal | null>;
  xtermHostRef: RefObject<HTMLDivElement | null>;
  scrollControllerRef: RefObject<SelectionScrollControllerHandle | null>;
  containerEl: HTMLDivElement | null;
  scrollState: { scrollLeft: number; scrollTop: number };
  ptyFontSize: number;
  suppressPtyFocus: () => void;
}

interface UsePtySelectionControllerResult {
  pointerHandlers: PointerHandlers;
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
}

export function usePtySelectionController(
  options: UsePtySelectionControllerOptions,
): UsePtySelectionControllerResult {
  const {
    terminalRef,
    xtermHostRef,
    scrollControllerRef,
    containerEl,
    scrollState,
    ptyFontSize,
    suppressPtyFocus,
  } = options;

  const selectionAnchorRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionFocusRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionLongPressCandidateRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionLongPressStartedAtBottomRef = useRef(false);
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

  const getToolbarPosition = useCallback(
    (clientX: number, clientY: number): { left: number; top: number } => {
      const visualViewport = window.visualViewport;
      return computePtySelectionToolbarPosition({
        clientX,
        clientY,
        viewportWidth: visualViewport?.width ?? window.innerWidth,
        viewportHeight: visualViewport?.height ?? window.innerHeight,
        viewportOffsetLeft: visualViewport?.offsetLeft ?? 0,
        viewportOffsetTop: visualViewport?.offsetTop ?? 0,
      });
    },
    [],
  );

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
    [terminalRef, xtermHostRef],
  );

  const getToolbarPositionForSelectionHandles = useCallback(
    (handles: PtySelectionHandles): { left: number; top: number } => {
      return getToolbarPosition(
        (handles.anchor.left + handles.focus.left) / 2,
        Math.min(handles.anchor.top, handles.focus.top),
      );
    },
    [getToolbarPosition],
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
    if (!handles) {
      setPtySelectionToolbar(null);
      return;
    }
    setPtySelectionToolbar((current) =>
      current ? getToolbarPositionForSelectionHandles(handles) : current,
    );
  }, [getSelectionHandles, getToolbarPositionForSelectionHandles]);

  const clearPtySelection = useCallback((): void => {
    selectionHandleDragCleanupRef.current?.();
    selectionHandleDragCleanupRef.current = null;
    stopPtySelectionAutoscroll();
    selectionLongPressCandidateRef.current = null;
    selectionLongPressStartedAtBottomRef.current = false;
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    selectionDraggedRef.current = false;
    selectedPtyTextRef.current = "";
    terminalRef.current?.clearSelection();
    setPtySelectionToolbar(null);
    setPtySelectionHandles(null);
  }, [stopPtySelectionAutoscroll, terminalRef]);

  const capturePtyLongPressCandidate = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      selectionLongPressCandidateRef.current =
        terminal && host ? getTerminalPointAtClient({ terminal, host, clientX, clientY }) : null;
      const container = containerEl;
      const scrollCtrl = scrollControllerRef.current;
      if (!terminal || !container || !scrollCtrl) {
        selectionLongPressStartedAtBottomRef.current = false;
        return;
      }
      const probe = scrollCtrl.getDebugProbe();
      const buffer = terminal.buffer.active;
      const anchor = computeScrollAnchor({
        rows: terminal.rows,
        cellH: probe.cellH,
        bufferLength: buffer.length,
        cursorBufferRow: buffer.baseY + buffer.cursorY,
        visibleContentHeight: Math.max(
          0,
          container.clientHeight - probe.paddingTop - probe.paddingBottom,
        ),
        paddingTop: probe.paddingTop,
        paddingBottom: probe.paddingBottom,
        containerScrollTop: container.scrollTop,
        containerScrollHeight: container.scrollHeight,
        containerClientHeight: container.clientHeight,
        atBottomThreshold: probe.atBottomThreshold,
      });
      selectionLongPressStartedAtBottomRef.current = anchor.isAtBottom;
    },
    [containerEl, scrollControllerRef, terminalRef, xtermHostRef],
  );

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
    [getSelectionHandles, terminalRef, xtermHostRef],
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
  }, [
    hasPtySelectionHandles,
    refreshSelectionHandles,
    scrollState.scrollLeft,
    scrollState.scrollTop,
  ]);

  const handlePtyLongPressStart = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      stopPtySelectionAutoscroll();
      selectionSuppressNativeTouchScrollRef.current = true;
      selectionDragHandleRef.current = "focus";
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return;
      const point =
        getTerminalPointAtClient({ terminal, host, clientX, clientY }) ??
        selectionLongPressCandidateRef.current;
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
    [stopPtySelectionAutoscroll, terminalRef, xtermHostRef],
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
      const focus =
        getTerminalPointAtClient({ terminal, host, clientX, clientY }) ?? selectionFocusRef.current;
      const selected =
        selectionDraggedRef.current && anchor && focus
          ? selectTerminalRange({ terminal, anchor, focus })
          : (selectTerminalInitialRangeAtPoint({ terminal, host, clientX, clientY }) ??
            (selectionLongPressCandidateRef.current
              ? selectTerminalInitialRangeAtBufferPoint({
                  terminal,
                  point: selectionLongPressCandidateRef.current,
                })
              : null));
      selectionLongPressCandidateRef.current = null;
      if (!selected?.text) {
        clearPtySelection();
        return;
      }

      selectionAnchorRef.current = selected.anchor;
      selectionFocusRef.current = selected.focus;
      selectedPtyTextRef.current = selected.text;
      const handles = getSelectionHandles(selected.anchor, selected.focus);
      setPtySelectionHandles(handles);
      setPtySelectionToolbar(
        handles
          ? getToolbarPositionForSelectionHandles(handles)
          : getToolbarPosition(clientX, clientY),
      );
      if (selectionLongPressStartedAtBottomRef.current) {
        scrollControllerRef.current?.scrollToBottom("selectionLongPress", { force: true });
      }
      selectionLongPressStartedAtBottomRef.current = false;
    },
    [
      clearPtySelection,
      getSelectionHandles,
      getToolbarPosition,
      getToolbarPositionForSelectionHandles,
      scrollControllerRef,
      stopPtySelectionAutoscroll,
      terminalRef,
      xtermHostRef,
    ],
  );

  const copyPtySelection = useCallback((): void => {
    const terminal = terminalRef.current;
    const selected = terminal?.getSelection?.() || selectedPtyTextRef.current;
    if (!selected) return;

    void copyText(selected).then((result) => {
      clearPtySelection();
      if (result === "failed") toast.error("复制失败");
    });
  }, [clearPtySelection, terminalRef]);

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
        if (selectedPtyTextRef.current)
          setPtySelectionToolbar(getToolbarPosition(point.clientX, point.clientY));
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
    [
      applyPtySelectionRange,
      getToolbarPosition,
      stopPtySelectionAutoscroll,
      updatePtySelectionAutoscroll,
    ],
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
    [
      applyPtySelectionRange,
      getToolbarPosition,
      stopPtySelectionAutoscroll,
      updatePtySelectionAutoscroll,
    ],
  );

  const pointerHandlers = usePtyTouchGesture({
    terminalRef,
    suppressPtyFocus,
    onLongPressCandidateStart: capturePtyLongPressCandidate,
    onLongPressStart: handlePtyLongPressStart,
    onLongPressMove: handlePtyLongPressMove,
    onLongPressEnd: handlePtyLongPressEnd,
  });

  return {
    pointerHandlers,
    ptySelectionToolbar,
    ptySelectionHandles,
    ptySelectionHandleMetrics,
    copyPtySelection,
    handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart,
  };
}
