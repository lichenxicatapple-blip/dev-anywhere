import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  selectTerminalFileDownloadLinkAtBufferPoint,
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
import { computePtySelectionToolbarPosition } from "@/lib/pty-selection-overlay-position";
import {
  usePtySelectionGestureDriver,
  type PtySelectionHandleKind,
} from "./use-pty-selection-gesture-driver";

const LONG_PRESS_MOVE_THRESHOLD_PX = 8;

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
  relayout: () => void;
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
}

interface UsePtySelectionControllerOptions {
  terminalRef: RefObject<Terminal | null>;
  xtermHostRef: RefObject<HTMLDivElement | null>;
  scrollControllerRef: RefObject<SelectionScrollControllerHandle | null>;
  containerEl: HTMLDivElement | null;
  scrollState: { scrollLeft: number; scrollTop: number };
  keyboardOffset: number;
  ptyFontSize: number;
  suppressPtyFocus: () => void;
  onDownloadPath: (path: string) => void;
}

interface UsePtySelectionControllerResult {
  pointerHandlers: PointerHandlers;
  ptySelectionToolbar: { left: number; top: number } | null;
  ptySelectionHandles: PtySelectionHandles | null;
  ptySelectionDownloadPath: string | null;
  ptySelectionHandleMetrics: PtySelectionHandleMetrics;
  copyPtySelection: () => void;
  downloadPtySelection: () => void;
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
    keyboardOffset,
    ptyFontSize,
    suppressPtyFocus,
    onDownloadPath,
  } = options;

  const selectionAnchorRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionFocusRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionLongPressCandidateRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionLongPressClientStartRef = useRef<{ clientX: number; clientY: number } | null>(
    null,
  );
  const selectionDraggedRef = useRef(false);
  const selectedDownloadPathRef = useRef<string | null>(null);
  const selectedPtyTextRef = useRef("");
  const stopPtySelectionGestureRef = useRef<(() => void) | null>(null);
  const [ptySelectionToolbar, setPtySelectionToolbar] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [ptySelectionHandles, setPtySelectionHandles] = useState<PtySelectionHandles | null>(null);
  const [ptySelectionDownloadPath, setPtySelectionDownloadPath] = useState<string | null>(null);
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

  const keepToolbarPositionInViewport = useCallback(
    (position: { left: number; top: number }): { left: number; top: number } => {
      const visualViewport = window.visualViewport;
      return computePtySelectionToolbarPosition({
        clientX: position.left,
        clientY: position.top + 48,
        viewportWidth: visualViewport?.width ?? window.innerWidth,
        viewportHeight: visualViewport?.height ?? window.innerHeight,
        viewportOffsetLeft: visualViewport?.offsetLeft ?? 0,
        viewportOffsetTop: visualViewport?.offsetTop ?? 0,
      });
    },
    [],
  );

  const refreshSelectionHandles = useCallback(
    (mode: "track-selection" | "preserve-toolbar" = "track-selection"): void => {
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
        current
          ? mode === "track-selection"
            ? getToolbarPositionForSelectionHandles(handles)
            : keepToolbarPositionInViewport(current)
          : current,
      );
    },
    [getSelectionHandles, getToolbarPositionForSelectionHandles, keepToolbarPositionInViewport],
  );

  const clearPtySelection = useCallback((): void => {
    stopPtySelectionGestureRef.current?.();
    selectionLongPressCandidateRef.current = null;
    selectionLongPressClientStartRef.current = null;
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    selectionDraggedRef.current = false;
    selectedDownloadPathRef.current = null;
    selectedPtyTextRef.current = "";
    terminalRef.current?.clearSelection();
    setPtySelectionToolbar(null);
    setPtySelectionHandles(null);
    setPtySelectionDownloadPath(null);
  }, [terminalRef]);

  const capturePtyLongPressCandidate = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      selectionLongPressClientStartRef.current = { clientX, clientY };
      selectionLongPressCandidateRef.current =
        terminal && host ? getTerminalPointAtClient({ terminal, host, clientX, clientY }) : null;
    },
    [terminalRef, xtermHostRef],
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
      selectedDownloadPathRef.current = null;
      setPtySelectionDownloadPath(null);
      const selected = selectTerminalRange({ terminal, anchor: nextAnchor, focus: nextFocus });
      selectedPtyTextRef.current = selected?.text ?? "";
      setPtySelectionHandles(selected ? getSelectionHandles(nextAnchor, nextFocus) : null);
      return selected;
    },
    [getSelectionHandles, terminalRef, xtermHostRef],
  );

  const applyPtyInitialSelection = useCallback(
    ({
      point,
      clientX,
      clientY,
      showToolbar = true,
    }: {
      point: TerminalSelectionPoint | null;
      clientX: number;
      clientY: number;
      showToolbar?: boolean;
    }): boolean => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return false;

      const linkSelection = point
        ? selectTerminalFileDownloadLinkAtBufferPoint({ terminal, point })
        : null;
      const selected =
        linkSelection ??
        (point
          ? selectTerminalInitialRangeAtBufferPoint({
              terminal,
              point,
            })
          : selectTerminalInitialRangeAtPoint({ terminal, host, clientX, clientY }));
      if (!selected?.text) return false;

      selectionAnchorRef.current = selected.anchor;
      selectionFocusRef.current = selected.focus;
      selectedDownloadPathRef.current = linkSelection?.downloadPath ?? null;
      setPtySelectionDownloadPath(linkSelection?.downloadPath ?? null);
      selectedPtyTextRef.current = selected.text;
      const handles = getSelectionHandles(selected.anchor, selected.focus);
      setPtySelectionHandles(handles);
      if (showToolbar) {
        setPtySelectionToolbar(
          handles
            ? getToolbarPositionForSelectionHandles(handles)
            : getToolbarPosition(clientX, clientY),
        );
      }
      return true;
    },
    [
      getSelectionHandles,
      getToolbarPosition,
      getToolbarPositionForSelectionHandles,
      terminalRef,
      xtermHostRef,
    ],
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
  useLayoutEffect(() => {
    if (!hasPtySelectionHandles) return;
    scrollControllerRef.current?.relayout();
    refreshSelectionHandles("preserve-toolbar");
  }, [hasPtySelectionHandles, keyboardOffset, refreshSelectionHandles, scrollControllerRef]);

  useEffect(() => {
    if (!hasPtySelectionHandles) return;
    refreshSelectionHandles("track-selection");
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
      raf = requestAnimationFrame(() => refreshSelectionHandles("preserve-toolbar"));
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
        selectedDownloadPathRef.current = null;
        selectedPtyTextRef.current = "";
        setPtySelectionToolbar(null);
        setPtySelectionHandles(null);
        setPtySelectionDownloadPath(null);
        return;
      }
      selectionAnchorRef.current = point;
      selectionFocusRef.current = point;
      selectionDraggedRef.current = false;
      selectedDownloadPathRef.current = null;
      selectedPtyTextRef.current = "";
      setPtySelectionToolbar(null);
      setPtySelectionHandles(null);
      setPtySelectionDownloadPath(null);
      applyPtyInitialSelection({ point, clientX, clientY, showToolbar: false });
    },
    [applyPtyInitialSelection, terminalRef, xtermHostRef],
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
      const endPoint = getTerminalPointAtClient({ terminal, host, clientX, clientY });
      const focus = endPoint ?? selectionFocusRef.current;
      const candidate = selectionLongPressCandidateRef.current;
      const clientStart = selectionLongPressClientStartRef.current;
      const clientMoved = clientStart
        ? Math.hypot(clientX - clientStart.clientX, clientY - clientStart.clientY) >=
          LONG_PRESS_MOVE_THRESHOLD_PX
        : false;
      const linkPoint = candidate ?? endPoint;
      if (!selectionDraggedRef.current && !clientMoved && selectedPtyTextRef.current) {
        showToolbarForCurrentSelection();
        selectionLongPressCandidateRef.current = null;
        selectionLongPressClientStartRef.current = null;
        return;
      }
      const linkSelection =
        !selectionDraggedRef.current && !clientMoved && linkPoint
          ? selectTerminalFileDownloadLinkAtBufferPoint({ terminal, point: linkPoint })
          : null;
      const rangeFocus = clientMoved ? (endPoint ?? focus) : focus;
      const selected =
        (selectionDraggedRef.current || clientMoved) && anchor && rangeFocus
          ? selectTerminalRange({ terminal, anchor, focus: rangeFocus })
          : (linkSelection ??
            selectTerminalInitialRangeAtPoint({ terminal, host, clientX, clientY }) ??
            (candidate
              ? selectTerminalInitialRangeAtBufferPoint({
                  terminal,
                  point: candidate,
                })
              : null));
      selectionLongPressCandidateRef.current = null;
      selectionLongPressClientStartRef.current = null;
      if (!selected?.text) {
        clearPtySelection();
        return;
      }

      selectionAnchorRef.current = selected.anchor;
      selectionFocusRef.current = selected.focus;
      selectedDownloadPathRef.current = linkSelection?.downloadPath ?? null;
      setPtySelectionDownloadPath(linkSelection?.downloadPath ?? null);
      selectedPtyTextRef.current = selected.text;
      const handles = getSelectionHandles(selected.anchor, selected.focus);
      setPtySelectionHandles(handles);
      setPtySelectionToolbar(
        handles
          ? getToolbarPositionForSelectionHandles(handles)
          : getToolbarPosition(clientX, clientY),
      );
    },
    [
      clearPtySelection,
      getSelectionHandles,
      getToolbarPosition,
      getToolbarPositionForSelectionHandles,
      showToolbarForCurrentSelection,
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

  const downloadPtySelection = useCallback((): void => {
    const path = selectedDownloadPathRef.current;
    if (!path) return;
    onDownloadPath(path);
    clearPtySelection();
  }, [clearPtySelection, onDownloadPath]);

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
    ptySelectionDownloadPath,
    ptySelectionHandleMetrics,
    copyPtySelection,
    downloadPtySelection,
    handlePtySelectionHandlePointerDown: selectionGesture.handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart: selectionGesture.handlePtySelectionHandleTouchStart,
  };
}
