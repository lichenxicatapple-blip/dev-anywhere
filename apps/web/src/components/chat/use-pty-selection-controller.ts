import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import {
  getTerminalPointAtClient,
  selectTerminalInitialRangeAtBufferPoint,
  selectTerminalInitialRangeAtPoint,
  selectTerminalRange,
  type TerminalSelectionPoint,
} from "@/lib/pty-line-selection";
import {
  computePtySelectionHandleMetrics,
  computePtySelectionToolbarPositionForHandles,
  getPtySelectionHandles,
  type PtySelectionHandleMetrics,
  type PtySelectionHandles,
  type PtySelectionHandlePosition,
} from "@/lib/pty-selection-layout";
import { computeScrollAnchor } from "@/lib/pty-scroll";
import type { PtyScrollDebugProbe } from "@/lib/pty-scroll-debug-snapshot";
import { computePtySelectionToolbarPosition } from "@/lib/pty-selection-overlay-position";
import {
  usePtySelectionGestureDriver,
  type PtySelectionHandleKind,
} from "./use-pty-selection-gesture-driver";

export type { PtySelectionHandleMetrics, PtySelectionHandles, PtySelectionHandlePosition };
export type { PtySelectionHandleKind } from "./use-pty-selection-gesture-driver";

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
  const stopPtySelectionGestureRef = useRef<(() => void) | null>(null);
  const [ptySelectionToolbar, setPtySelectionToolbar] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [ptySelectionHandles, setPtySelectionHandles] = useState<PtySelectionHandles | null>(null);
  const ptySelectionHandleMetrics = useMemo<PtySelectionHandleMetrics>(
    () => computePtySelectionHandleMetrics(ptyFontSize),
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

  const getSelectionHandles = useCallback(
    (anchor: TerminalSelectionPoint, focus: TerminalSelectionPoint): PtySelectionHandles | null => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return null;
      return getPtySelectionHandles({
        terminal,
        host,
        anchor,
        focus,
      });
    },
    [terminalRef, xtermHostRef],
  );

  const getToolbarPositionForSelectionHandles = useCallback(
    (handles: PtySelectionHandles): { left: number; top: number } => {
      const visualViewport = window.visualViewport;
      return computePtySelectionToolbarPositionForHandles({
        handles,
        viewportWidth: visualViewport?.width ?? window.innerWidth,
        viewportHeight: visualViewport?.height ?? window.innerHeight,
        viewportOffsetLeft: visualViewport?.offsetLeft ?? 0,
        viewportOffsetTop: visualViewport?.offsetTop ?? 0,
      });
    },
    [],
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
    stopPtySelectionGestureRef.current?.();
    selectionLongPressCandidateRef.current = null;
    selectionLongPressStartedAtBottomRef.current = false;
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    selectionDraggedRef.current = false;
    selectedPtyTextRef.current = "";
    terminalRef.current?.clearSelection();
    setPtySelectionToolbar(null);
    setPtySelectionHandles(null);
  }, [terminalRef]);

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
    ({
      clientX,
      clientY,
      draggedHandle = "focus",
    }: {
      clientX: number;
      clientY: number;
      draggedHandle?: PtySelectionHandleKind;
    }) => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      const anchor = selectionAnchorRef.current;
      const focusPoint = selectionFocusRef.current;
      if (!terminal || !host || !anchor) return null;
      const focus = getTerminalPointAtClient({ terminal, host, clientX, clientY });
      if (!focus) return null;
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

  const showToolbarForCurrentSelection = useCallback((): void => {
    const anchor = selectionAnchorRef.current;
    const focusPoint = selectionFocusRef.current;
    if (!anchor || !focusPoint) {
      setPtySelectionToolbar(null);
      return;
    }
    const handles = getSelectionHandles(anchor, focusPoint);
    setPtySelectionHandles(handles);
    setPtySelectionToolbar(handles ? getToolbarPositionForSelectionHandles(handles) : null);
  }, [getSelectionHandles, getToolbarPositionForSelectionHandles]);

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

  useEffect(() => {
    if (!hasPtySelectionHandles) return;
    const visualViewport = window.visualViewport;
    let raf = 0;
    const scheduleRefresh = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refreshSelectionHandles);
    };

    window.addEventListener("resize", scheduleRefresh);
    visualViewport?.addEventListener("resize", scheduleRefresh);
    visualViewport?.addEventListener("scroll", scheduleRefresh);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduleRefresh);
      visualViewport?.removeEventListener("resize", scheduleRefresh);
      visualViewport?.removeEventListener("scroll", scheduleRefresh);
    };
  }, [hasPtySelectionHandles, refreshSelectionHandles]);

  const handlePtyLongPressStart = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
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
    [terminalRef, xtermHostRef],
  );

  const handlePtyLongPressMove = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      applyPtySelectionRange({ clientX, clientY });
      setPtySelectionToolbar(null);
    },
    [applyPtySelectionRange],
  );

  const handlePtyLongPressEnd = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
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

  const isSelectionActive = useCallback((): boolean => selectionAnchorRef.current !== null, []);

  const handlePtySelectionHandleDragStart = useCallback((): void => {
    setPtySelectionToolbar(null);
  }, []);

  const handlePtySelectionHandleDragMove = useCallback(
    (kind: PtySelectionHandleKind, { clientX, clientY }: { clientX: number; clientY: number }) => {
      applyPtySelectionRange({ clientX, clientY, draggedHandle: kind });
      setPtySelectionToolbar(null);
    },
    [applyPtySelectionRange],
  );

  const handlePtySelectionHandleDragEnd = useCallback(
    (kind: PtySelectionHandleKind, point: { clientX: number; clientY: number } | null): void => {
      if (point) {
        applyPtySelectionRange({ ...point, draggedHandle: kind });
      }
      if (selectedPtyTextRef.current) showToolbarForCurrentSelection();
    },
    [applyPtySelectionRange, showToolbarForCurrentSelection],
  );

  const selectionGesture = usePtySelectionGestureDriver({
    terminalRef,
    containerEl,
    suppressPtyFocus,
    isSelectionActive,
    onLongPressCandidateStart: capturePtyLongPressCandidate,
    onLongPressStart: handlePtyLongPressStart,
    onLongPressMove: handlePtyLongPressMove,
    onLongPressEnd: handlePtyLongPressEnd,
    onHandleDragStart: handlePtySelectionHandleDragStart,
    onHandleDragMove: handlePtySelectionHandleDragMove,
    onHandleDragEnd: handlePtySelectionHandleDragEnd,
    onHandleDragCancel: handlePtySelectionHandleDragStart,
  });
  stopPtySelectionGestureRef.current = selectionGesture.stopPtySelectionGesture;

  return {
    pointerHandlers: selectionGesture.pointerHandlers,
    ptySelectionToolbar,
    ptySelectionHandles,
    ptySelectionHandleMetrics,
    copyPtySelection,
    handlePtySelectionHandlePointerDown: selectionGesture.handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart: selectionGesture.handlePtySelectionHandleTouchStart,
  };
}
