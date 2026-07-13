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
  selectTerminalInitialRangeAtBufferPoint,
  selectTerminalInitialRangeAtPoint,
  selectTerminalPathLinkAtBufferPoint,
  selectTerminalRange,
  type TerminalSelectionPoint,
} from "@/lib/pty-line-selection";
import {
  computePtySelectionHandleMetrics,
  computePtySelectionToolbarPositionForHandles,
  getPtySelectionHandles,
  type PtySelectionHandleMetrics,
  type PtySelectionHandles,
} from "@/lib/pty-selection-layout";
import { computePtySelectionToolbarPosition } from "@/lib/pty-selection-overlay-position";
import {
  resolvePtySelectionPathAction,
  type PtySelectionPathAction,
} from "@/lib/pty-selection-path-action";
import {
  usePtySelectionGestureDriver,
  type PtySelectionHandleKind,
} from "./use-pty-selection-gesture-driver";

const LONG_PRESS_MOVE_THRESHOLD_PX = 8;

export type { PtySelectionHandleMetrics, PtySelectionHandles, PtySelectionPathAction };
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
  markHorizontalScrollIntent: (reason?: string) => void;
}

interface UsePtySelectionControllerOptions {
  sessionId: string;
  terminalRef: RefObject<Terminal | null>;
  xtermHostRef: RefObject<HTMLDivElement | null>;
  scrollControllerRef: RefObject<SelectionScrollControllerHandle | null>;
  containerEl: HTMLDivElement | null;
  scrollState: { scrollLeft: number; scrollTop: number };
  keyboardOffset: number;
  ptyFontSize: number;
  suppressPtyFocus: (options?: { blur?: boolean }) => void;
  focusPtyInput: () => void;
  onTap?: (point: { clientX: number; clientY: number }) => boolean;
  isTapCandidate?: (point: { clientX: number; clientY: number }) => boolean;
  onDownloadPath: (path: string) => void;
  onPreviewPath: (path: string) => void;
}

interface UsePtySelectionControllerResult {
  pointerHandlers: PointerHandlers;
  ptySelectionToolbar: { left: number; top: number } | null;
  ptySelectionHandles: PtySelectionHandles | null;
  ptySelectionPathAction: PtySelectionPathAction | null;
  ptySelectionHandleMetrics: PtySelectionHandleMetrics;
  copyPtySelection: () => void;
  openPtySelectionPathAction: () => void;
  handlePtySelectionHandlePointerDown: (
    kind: PtySelectionHandleKind,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  handlePtySelectionHandleTouchStart: (
    kind: PtySelectionHandleKind,
    event: ReactTouchEvent<HTMLElement>,
  ) => void;
}

interface PtySelectionTestController {
  selectRange: (options: {
    anchorRow: number;
    focusRow: number;
    anchorColumn?: number;
    focusColumn?: number;
  }) => boolean;
  clear: () => void;
}

declare global {
  interface Window {
    __ccTestPtySelectionControllers?: Map<string, PtySelectionTestController>;
  }
}

export function usePtySelectionController(
  options: UsePtySelectionControllerOptions,
): UsePtySelectionControllerResult {
  const {
    sessionId,
    terminalRef,
    xtermHostRef,
    scrollControllerRef,
    containerEl,
    scrollState,
    keyboardOffset,
    ptyFontSize,
    suppressPtyFocus,
    focusPtyInput,
    onTap,
    isTapCandidate,
    onDownloadPath,
    onPreviewPath,
  } = options;

  const selectionAnchorRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionFocusRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionLongPressCandidateRef = useRef<TerminalSelectionPoint | null>(null);
  const selectionLongPressClientStartRef = useRef<{ clientX: number; clientY: number } | null>(
    null,
  );
  const selectionDraggedRef = useRef(false);
  const selectedPathActionRef = useRef<PtySelectionPathAction | null>(null);
  const selectedPtyTextRef = useRef("");
  const stopPtySelectionGestureRef = useRef<(() => void) | null>(null);
  const [ptySelectionToolbar, setPtySelectionToolbar] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [ptySelectionHandles, setPtySelectionHandles] = useState<PtySelectionHandles | null>(null);
  const [ptySelectionPathAction, setPtySelectionPathAction] =
    useState<PtySelectionPathAction | null>(null);
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

  const setSelectedPathAction = useCallback(
    (
      selectedText: string,
      explicitPathAction?: PtySelectionPathAction | null,
    ): PtySelectionPathAction | null => {
      const action = explicitPathAction ?? resolvePtySelectionPathAction(selectedText);
      selectedPathActionRef.current = action;
      setPtySelectionPathAction(action);
      return action;
    },
    [],
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
    selectionLongPressClientStartRef.current = null;
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    selectionDraggedRef.current = false;
    selectedPathActionRef.current = null;
    selectedPtyTextRef.current = "";
    terminalRef.current?.clearSelection();
    setPtySelectionToolbar(null);
    setPtySelectionHandles(null);
    setPtySelectionPathAction(null);
  }, [terminalRef]);

  const hidePtySelectionControls = useCallback((selectedText: string = ""): void => {
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    selectionDraggedRef.current = false;
    selectedPathActionRef.current = null;
    selectedPtyTextRef.current = selectedText;
    setPtySelectionToolbar(null);
    setPtySelectionHandles(null);
    setPtySelectionPathAction(null);
  }, []);

  const capturePtyLongPressCandidate = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      suppressPtyFocus({ blur: false });
      selectionLongPressClientStartRef.current = { clientX, clientY };
      selectionLongPressCandidateRef.current =
        terminal && host ? getTerminalPointAtClient({ terminal, host, clientX, clientY }) : null;
    },
    [suppressPtyFocus, terminalRef, xtermHostRef],
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
      setSelectedPathAction(selected?.text ?? "");
      setPtySelectionHandles(selected ? getSelectionHandles(nextAnchor, nextFocus) : null);
      return selected;
    },
    [getSelectionHandles, setSelectedPathAction, terminalRef, xtermHostRef],
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

      const pathSelection = point ? selectTerminalPathLinkAtBufferPoint({ terminal, point }) : null;
      const selected =
        pathSelection ??
        (point
          ? selectTerminalInitialRangeAtBufferPoint({
              terminal,
              point,
            })
          : selectTerminalInitialRangeAtPoint({ terminal, host, clientX, clientY }));
      if (!selected?.text) return false;

      selectionAnchorRef.current = selected.anchor;
      selectionFocusRef.current = selected.focus;
      selectedPtyTextRef.current = selected.text;
      setSelectedPathAction(selected.text, pathSelection?.pathAction);
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
      setSelectedPathAction,
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

  const showToolbarForNativeSelection = useCallback(
    (point: { clientX: number; clientY: number }): void => {
      const selectedText = terminalRef.current?.getSelection?.() ?? "";
      const action = setSelectedPathAction(selectedText);
      selectedPtyTextRef.current = selectedText;
      selectionAnchorRef.current = null;
      selectionFocusRef.current = null;
      selectionDraggedRef.current = false;
      setPtySelectionHandles(null);
      setPtySelectionToolbar(action ? getToolbarPosition(point.clientX, point.clientY) : null);
    },
    [getToolbarPosition, setSelectedPathAction, terminalRef],
  );

  useEffect(() => {
    const host = xtermHostRef.current;
    if (!host) return;

    let mouseDownInTerminal = false;
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".xterm")) return;
      mouseDownInTerminal = true;
      hidePtySelectionControls(terminalRef.current?.getSelection?.() ?? "");
    };
    const handlePointerUp = (event: PointerEvent): void => {
      if (event.pointerType !== "mouse" || !mouseDownInTerminal) return;
      mouseDownInTerminal = false;
      const point = { clientX: event.clientX, clientY: event.clientY };
      window.setTimeout(() => showToolbarForNativeSelection(point), 0);
    };
    const handlePointerCancel = (): void => {
      mouseDownInTerminal = false;
    };

    host.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    return () => {
      host.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
    };
  }, [hidePtySelectionControls, showToolbarForNativeSelection, terminalRef, xtermHostRef]);

  useLayoutEffect(() => {
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
    refreshSelectionHandles();
  }, [hasPtySelectionHandles, keyboardOffset, refreshSelectionHandles, scrollControllerRef]);

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
    let settleTimer = 0;
    const scheduleRefresh = (): void => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      raf = requestAnimationFrame(() => {
        refreshSelectionHandles();
        settleTimer = window.setTimeout(() => {
          raf = requestAnimationFrame(() => refreshSelectionHandles());
        }, 160);
      });
    };

    scheduleRefresh();
    window.addEventListener("resize", scheduleRefresh);
    visualViewport?.addEventListener("resize", scheduleRefresh);
    visualViewport?.addEventListener("scroll", scheduleRefresh);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
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
        selectedPathActionRef.current = null;
        selectedPtyTextRef.current = "";
        setPtySelectionToolbar(null);
        setPtySelectionHandles(null);
        setPtySelectionPathAction(null);
        return;
      }
      selectionAnchorRef.current = point;
      selectionFocusRef.current = point;
      selectionDraggedRef.current = false;
      selectedPathActionRef.current = null;
      selectedPtyTextRef.current = "";
      setPtySelectionToolbar(null);
      setPtySelectionHandles(null);
      setPtySelectionPathAction(null);
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
      const pathSelection =
        !selectionDraggedRef.current && !clientMoved && linkPoint
          ? selectTerminalPathLinkAtBufferPoint({ terminal, point: linkPoint })
          : null;
      const rangeFocus = clientMoved ? (endPoint ?? focus) : focus;
      const selected =
        (selectionDraggedRef.current || clientMoved) && anchor && rangeFocus
          ? selectTerminalRange({ terminal, anchor, focus: rangeFocus })
          : (pathSelection ??
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
      selectedPtyTextRef.current = selected.text;
      setSelectedPathAction(selected.text, pathSelection?.pathAction);
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
      setSelectedPathAction,
      showToolbarForCurrentSelection,
      terminalRef,
      xtermHostRef,
    ],
  );

  const copyPtySelection = useCallback((): void => {
    const terminal = terminalRef.current;
    const selected = terminal?.getSelection?.() || selectedPtyTextRef.current;
    if (!selected) return;

    void copyText(selected, { allowLegacyFallback: true }).then((result) => {
      clearPtySelection();
      if (result === "failed") toast.error("复制失败");
      else toast.success("已复制");
    });
  }, [clearPtySelection, terminalRef]);

  const openPtySelectionPathAction = useCallback((): void => {
    const action = selectedPathActionRef.current;
    if (!action) return;
    if (action.kind === "image-preview") onPreviewPath(action.path);
    else onDownloadPath(action.path);
    clearPtySelection();
  }, [clearPtySelection, onDownloadPath, onPreviewPath]);

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

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const controllers = (window.__ccTestPtySelectionControllers ??= new Map());
    const controller: PtySelectionTestController = {
      selectRange: ({ anchorRow, focusRow, anchorColumn = 0, focusColumn }) => {
        const terminal = terminalRef.current;
        if (!terminal) return false;
        const focusLine = terminal.buffer.active.getLine(focusRow)?.translateToString(true) ?? "";
        const focus = {
          row: focusRow,
          column: Math.max(0, focusColumn ?? Math.min(focusLine.length - 1, terminal.cols - 1)),
        };
        const anchor = { row: anchorRow, column: Math.max(0, anchorColumn) };
        const selected = selectTerminalRange({ terminal, anchor, focus });
        if (!selected?.text) return false;

        selectionAnchorRef.current = selected.anchor;
        selectionFocusRef.current = selected.focus;
        selectedPathActionRef.current = null;
        selectedPtyTextRef.current = selected.text;
        setSelectedPathAction(selected.text);
        const handles = getSelectionHandles(selected.anchor, selected.focus);
        setPtySelectionHandles(handles);
        setPtySelectionToolbar(handles ? getToolbarPositionForSelectionHandles(handles) : null);
        return true;
      },
      clear: clearPtySelection,
    };
    controllers.set(sessionId, controller);
    return () => {
      if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
    };
  }, [
    clearPtySelection,
    getSelectionHandles,
    getToolbarPositionForSelectionHandles,
    sessionId,
    setSelectedPathAction,
    terminalRef,
  ]);

  const selectionGesture = usePtySelectionGestureDriver({
    terminalRef,
    containerEl,
    suppressPtyFocus,
    focusPtyInput,
    isSelectionActive,
    onTap,
    isTapCandidate,
    onLongPressCandidateStart: capturePtyLongPressCandidate,
    onLongPressStart: handlePtyLongPressStart,
    onLongPressMove: handlePtyLongPressMove,
    onLongPressEnd: handlePtyLongPressEnd,
    onHorizontalScrollIntent: (reason) =>
      scrollControllerRef.current?.markHorizontalScrollIntent(reason),
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
    ptySelectionPathAction,
    ptySelectionHandleMetrics,
    copyPtySelection,
    openPtySelectionPathAction,
    handlePtySelectionHandlePointerDown: selectionGesture.handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart: selectionGesture.handlePtySelectionHandleTouchStart,
  };
}
