import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { IBuffer, IBufferLine, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { getEdgeAutoscrollDelta } from "@/lib/pty-edge-autoscroll";
import {
  getTerminalPointAtClient,
  resolveTerminalInitialRangeAtBufferPoint,
  resolveTerminalLineAtBufferPoint,
  resolveTerminalPathLinkAtBufferPoint,
  resolveTerminalRange,
  type TerminalSelectionPoint,
  type TerminalSelectionResult,
} from "@/lib/pty-line-selection";
import {
  canPtyManagedSelectionAutoscroll,
  createInitialPtyManagedSelectionState,
  getPtyManagedSelectionRange,
  rebasePtyManagedSelectionRows,
  rebasePtySelectionRangeRows,
  reducePtyManagedSelection,
  type PtyManagedSelectionState,
  type PtySelectionRange,
} from "@/lib/pty-managed-selection-state";
import {
  attachPtyManagedSelectionOverlay,
  type PtyManagedSelectionOverlayController,
} from "@/lib/pty-managed-selection-overlay";
import {
  getRenderedPtyHistorySelectionLine,
  getRenderedPtyHistorySelectionLines,
} from "@/lib/pty-history-projection";
import {
  rebasePtySelectionLineSnapshots,
  snapshotPtySelectionBufferLine,
} from "@/lib/pty-selection-buffer-snapshot";
import {
  computePtySelectionHandleMetrics,
  computePtySelectionToolbarPositionForHandles,
  getPtySelectionHandles,
  type PtySelectionHandleMetrics,
  type PtySelectionHandles,
} from "@/lib/pty-selection-layout";
import {
  computePtySelectionToolbarPosition,
  shouldDeferPtySelectionDismissOnInteractionStart,
  shouldDismissManagedPtySelectionAfterGesture,
} from "@/lib/pty-selection-overlay-position";
import {
  resolvePtySelectionPathAction,
  type PtySelectionPathAction,
} from "@/lib/pty-selection-path-action";
import {
  captureXtermDesktopLinkCandidate,
  type XtermDesktopLinkCandidate,
  type XtermLinkActivationPoint,
} from "@/lib/xterm-touch-link-activation";
import {
  usePtySelectionGestureDriver,
  type PtySelectionHandleKind,
} from "./use-pty-selection-gesture-driver";

const DESKTOP_DRAG_THRESHOLD_PX = 2;
const VIEWPORT_SELECTION_SETTLE_MS = 600;
const SELECTION_TOOLBAR_SCROLL_SETTLE_MS = 160;

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
  markSelectionAutoscrollIntent: (reason?: string) => void;
  markHorizontalScrollIntent: (reason?: string) => void;
}

interface UsePtySelectionControllerOptions {
  sessionId: string;
  terminalRef: RefObject<Terminal | null>;
  xtermHostRef: RefObject<HTMLDivElement | null>;
  selectionHandleLayerRef: RefObject<HTMLDivElement | null>;
  scrollControllerRef: RefObject<SelectionScrollControllerHandle | null>;
  containerEl: HTMLDivElement | null;
  keyboardOffset: number;
  ptyFontSize: number;
  suppressPtyFocus: (options?: { blur?: boolean }) => void;
  focusPtyInput: () => void;
  onTap?: (point: XtermLinkActivationPoint) => boolean;
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
  hasPtySelection: () => boolean;
  clearManagedPtySelection: () => void;
  clearPtySelection: () => void;
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

type SelectionToolbarMode = "hide" | "show" | "path-only";

type PtySelectionToolbarPosition = { left: number; top: number };

interface SelectionPresentation {
  handles: boolean;
  toolbar: SelectionToolbarMode;
  clientPoint?: { clientX: number; clientY: number };
  explicitPathAction?: PtySelectionPathAction | null;
}

interface DesktopSelectionGesture {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  shiftExtend: boolean;
  unit: "cell" | "word" | "line";
  initialRange: PtySelectionRange | null;
  linkCandidate: XtermDesktopLinkCandidate | null;
  selectionLinesBeforePress: Map<number, IBufferLine>;
  selectionLines: Map<number, IBufferLine>;
}

interface CommittedSelectionMarkerBinding {
  readonly terminal: Terminal;
  readonly buffer: IBuffer;
  readonly cols: number;
  readonly rows: number;
  readonly anchor: IMarker | null;
  readonly focus: IMarker | null;
  readonly subscriptions: IDisposable[];
  sync: () => void;
}

function isMacPlatform(): boolean {
  // Match xterm's Browser.isMac decision exactly. iPadOS may expose touch plus a mouse, but xterm
  // does not treat that platform as macOS when deciding its force-selection modifier.
  return /^(Macintosh|MacIntel|MacPPC|Mac68K)$/u.test(navigator.platform);
}

function shouldForceDesktopSelection(terminal: Terminal, event: MouseEvent): boolean {
  return isMacPlatform()
    ? event.altKey && terminal.options.macOptionClickForcesSelection === true
    : event.shiftKey;
}

function shouldOwnDesktopSelection(terminal: Terminal, event: MouseEvent): boolean {
  return (
    terminal.modes.mouseTrackingMode === "none" || shouldForceDesktopSelection(terminal, event)
  );
}

function shouldColumnSelectDesktop(terminal: Terminal, event: MouseEvent): boolean {
  return (
    event.altKey && !(isMacPlatform() && terminal.options.macOptionClickForcesSelection === true)
  );
}

function compareTerminalPoints(
  a: Readonly<TerminalSelectionPoint>,
  b: Readonly<TerminalSelectionPoint>,
): number {
  return a.row === b.row ? a.column - b.column : a.row - b.row;
}

function normalizeManagedRange(range: PtySelectionRange): {
  start: TerminalSelectionPoint;
  end: TerminalSelectionPoint;
} {
  const anchor = toTerminalPoint(range.anchor);
  const focus = toTerminalPoint(range.focus);
  return compareTerminalPoints(anchor, focus) <= 0
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

function managedRangeContainsPoint(
  range: PtySelectionRange,
  point: Readonly<TerminalSelectionPoint>,
): boolean {
  if (range.columnMode) {
    return (
      point.row >= Math.min(range.anchor.row, range.focus.row) &&
      point.row <= Math.max(range.anchor.row, range.focus.row) &&
      point.column >= Math.min(range.anchor.column, range.focus.column) &&
      point.column <= Math.max(range.anchor.column, range.focus.column)
    );
  }
  const { start, end } = normalizeManagedRange(range);
  return compareTerminalPoints(point, start) >= 0 && compareTerminalPoints(point, end) <= 0;
}

function isCopyShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === "c" && (isMacPlatform() ? event.metaKey : event.ctrlKey);
}

function toTerminalPoint(point: Readonly<{ row: number; column: number }>): TerminalSelectionPoint {
  return { row: point.row, column: point.column };
}

function registerMarkerAtBufferRow(terminal: Terminal, row: number): IMarker | null {
  const buffer = terminal.buffer.active;
  if (buffer.type !== "normal") return null;
  if (!Number.isInteger(row) || row < 0 || row >= buffer.length || !buffer.getLine(row))
    return null;

  let marker: IMarker | undefined;
  try {
    marker = terminal.registerMarker(row - (buffer.baseY + buffer.cursorY));
  } catch {
    return null;
  }
  if (!marker || marker.isDisposed || marker.line !== row) {
    marker?.dispose();
    return null;
  }
  return marker;
}

export function usePtySelectionController(
  options: UsePtySelectionControllerOptions,
): UsePtySelectionControllerResult {
  const {
    terminalRef,
    xtermHostRef,
    selectionHandleLayerRef,
    scrollControllerRef,
    containerEl,
    keyboardOffset,
    ptyFontSize,
    suppressPtyFocus,
    focusPtyInput,
    onTap,
    isTapCandidate,
    onDownloadPath,
    onPreviewPath,
  } = options;

  const managedStateRef = useRef<PtyManagedSelectionState>(createInitialPtyManagedSelectionState());
  const overlayRef = useRef<PtyManagedSelectionOverlayController | null>(null);
  const overlayTerminalRef = useRef<Terminal | null>(null);
  const selectionLinesRef = useRef<Map<number, IBufferLine>>(new Map());
  const committedSelectionMarkersRef = useRef<CommittedSelectionMarkerBinding | null>(null);
  const selectedPathActionRef = useRef<PtySelectionPathAction | null>(null);
  const selectedPtyTextRef = useRef("");
  const selectionUsesHandlesRef = useRef(false);
  const longPressCandidateRef = useRef<TerminalSelectionPoint | null>(null);
  const longPressFixedEndpointRef = useRef<TerminalSelectionPoint | null>(null);
  const handleDragRestoreRef = useRef<{
    range: PtySelectionRange;
    lines: Map<number, IBufferLine>;
  } | null>(null);
  const activeHandleDragKindRef = useRef<PtySelectionHandleKind | null>(null);
  const toolbarPresentationRef = useRef<SelectionToolbarMode>("hide");
  const toolbarScrollSuppressedRef = useRef(false);
  const toolbarScrollGenerationRef = useRef(0);
  const toolbarScrollSettleTimerRef = useRef(0);
  const stopPtySelectionGestureRef = useRef<(() => void) | null>(null);
  const stopDesktopSelectionRef = useRef<(() => void) | null>(null);
  const selectionViewportTransitionUntilRef = useRef(0);
  const previousKeyboardOffsetRef = useRef(keyboardOffset);
  const [ptySelectionToolbar, setPtySelectionToolbar] =
    useState<PtySelectionToolbarPosition | null>(null);
  const [ptySelectionHandles, setPtySelectionHandles] = useState<PtySelectionHandles | null>(null);
  const [ptySelectionPathAction, setPtySelectionPathAction] =
    useState<PtySelectionPathAction | null>(null);
  const ptySelectionHandleMetrics = useMemo<PtySelectionHandleMetrics>(
    () => computePtySelectionHandleMetrics(ptyFontSize),
    [ptyFontSize],
  );

  const setToolbarPresentation = useCallback((mode: SelectionToolbarMode): void => {
    toolbarPresentationRef.current = mode;
    toolbarScrollSuppressedRef.current = false;
    toolbarScrollGenerationRef.current += 1;
    window.clearTimeout(toolbarScrollSettleTimerRef.current);
    toolbarScrollSettleTimerRef.current = 0;
  }, []);

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

  const getSelectionHandleViewportGeometry = useCallback(
    (
      handles: PtySelectionHandles,
    ): {
      clientHandles: PtySelectionHandles;
      visible: Record<PtySelectionHandleKind, boolean>;
    } | null => {
      const layer = selectionHandleLayerRef.current;
      if (!layer || !containerEl) return null;
      const layerRect = layer.getBoundingClientRect();
      const containerRect = containerEl.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const viewportLeft = Math.max(
        containerRect.left + containerEl.clientLeft,
        visualViewport?.offsetLeft ?? 0,
      );
      const viewportTop = Math.max(
        containerRect.top + containerEl.clientTop,
        visualViewport?.offsetTop ?? 0,
      );
      const viewportRight = Math.min(
        containerRect.left + containerEl.clientLeft + containerEl.clientWidth,
        (visualViewport?.offsetLeft ?? 0) + (visualViewport?.width ?? window.innerWidth),
      );
      const viewportBottom = Math.min(
        containerRect.top + containerEl.clientTop + containerEl.clientHeight,
        (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? window.innerHeight),
      );
      const clientHandles: PtySelectionHandles = {
        anchor: {
          left: handles.anchor.left + layerRect.left,
          top: handles.anchor.top + layerRect.top,
        },
        focus: {
          left: handles.focus.left + layerRect.left,
          top: handles.focus.top + layerRect.top,
        },
      };
      const isVisible = (position: PtySelectionHandles["anchor"]): boolean =>
        position.left >= viewportLeft &&
        position.left <= viewportRight &&
        position.top >= viewportTop &&
        position.top <= viewportBottom;
      return {
        clientHandles,
        visible: {
          anchor: isVisible(clientHandles.anchor),
          focus: isVisible(clientHandles.focus),
        },
      };
    },
    [containerEl, selectionHandleLayerRef],
  );

  const getToolbarPositionForVisibleSelectionHandles = useCallback(
    (handles: PtySelectionHandles): PtySelectionToolbarPosition | null => {
      const geometry = getSelectionHandleViewportGeometry(handles);
      if (!geometry) return null;
      const visibleHandles = (["anchor", "focus"] as const).filter(
        (kind) => geometry.visible[kind],
      );
      if (visibleHandles.length === 0) return null;
      const first = geometry.clientHandles[visibleHandles[0]];
      const second = geometry.clientHandles[visibleHandles[1] ?? visibleHandles[0]];
      const visualViewport = window.visualViewport;
      return computePtySelectionToolbarPositionForHandles({
        handles: { anchor: first, focus: second },
        viewportWidth: visualViewport?.width ?? window.innerWidth,
        viewportHeight: visualViewport?.height ?? window.innerHeight,
        viewportOffsetLeft: visualViewport?.offsetLeft ?? 0,
        viewportOffsetTop: visualViewport?.offsetTop ?? 0,
      });
    },
    [getSelectionHandleViewportGeometry],
  );

  const getSelectionLine = useCallback(
    (row: number): IBufferLine | null | undefined => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return null;
      return (
        getRenderedPtyHistorySelectionLine(host, row) ??
        selectionLinesRef.current.get(row) ??
        terminal.buffer.active.getLine(row)
      );
    },
    [terminalRef, xtermHostRef],
  );

  const getSelectionHandles = useCallback(
    (range: PtySelectionRange): PtySelectionHandles | null => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      const coordinateSpace = selectionHandleLayerRef.current;
      if (!terminal || !host || !coordinateSpace) return null;
      return getPtySelectionHandles({
        terminal,
        host,
        coordinateSpace,
        anchor: toTerminalPoint(range.anchor),
        focus: toTerminalPoint(range.focus),
        columnMode: range.columnMode,
        getLine: getSelectionLine,
      });
    },
    [getSelectionLine, selectionHandleLayerRef, terminalRef, xtermHostRef],
  );

  const ensureOverlay = useCallback((): PtyManagedSelectionOverlayController | null => {
    const terminal = terminalRef.current;
    if (!terminal || !containerEl || !terminal.element) return null;
    if (overlayRef.current && overlayTerminalRef.current === terminal) return overlayRef.current;
    overlayRef.current?.dispose();
    overlayRef.current = attachPtyManagedSelectionOverlay({
      terminal,
      container: containerEl,
      getLine: getSelectionLine,
    });
    overlayTerminalRef.current = terminal;
    return overlayRef.current;
  }, [containerEl, getSelectionLine, terminalRef]);

  const captureSelectionLines = useCallback(
    (range: PtySelectionRange, reset = false): void => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return;
      if (reset) selectionLinesRef.current = new Map();

      const firstRow = Math.min(range.anchor.row, range.focus.row);
      const lastRow = Math.max(range.anchor.row, range.focus.row);
      const renderedLines = getRenderedPtyHistorySelectionLines(host);
      for (const [row, line] of renderedLines) {
        if (row >= firstRow && row <= lastRow) {
          // Only derived live-backfill rows need a captured source. Native rows remain live,
          // matching xterm's normal rule that an in-place TUI redraw changes selected text too.
          // Overwrite projected rows when scrolling replaces the projection so painted text and
          // the copy source cannot drift apart.
          selectionLinesRef.current.set(row, snapshotPtySelectionBufferLine(line, terminal.cols));
        }
      }
      const nativeStart = Math.max(firstRow, terminal.buffer.active.viewportY);
      const nativeEnd = Math.min(lastRow, terminal.buffer.active.viewportY + terminal.rows - 1);
      for (let row = nativeStart; row <= nativeEnd; row += 1) {
        if (!renderedLines.has(row)) selectionLinesRef.current.delete(row);
      }
    },
    [terminalRef, xtermHostRef],
  );

  const pruneSelectionLines = useCallback((range: PtySelectionRange): void => {
    const firstRow = Math.min(range.anchor.row, range.focus.row);
    const lastRow = Math.max(range.anchor.row, range.focus.row);
    selectionLinesRef.current = new Map(
      Array.from(selectionLinesRef.current).filter(([row]) => row >= firstRow && row <= lastRow),
    );
  }, []);

  const getSelectionTerminalView = useCallback((): Terminal | null => {
    const terminal = terminalRef.current;
    const host = xtermHostRef.current;
    if (!terminal || !host) return null;
    const active = terminal.buffer.active;
    const activeView = new Proxy(active, {
      get(target, property) {
        if (property === "getLine") {
          return (row: number): IBufferLine | undefined =>
            selectionLinesRef.current.get(row) ??
            getRenderedPtyHistorySelectionLine(host, row) ??
            target.getLine(row);
        }
        if (property === "length") {
          let frozenLength = 0;
          for (const row of selectionLinesRef.current.keys()) {
            frozenLength = Math.max(frozenLength, row + 1);
          }
          return Math.max(target.length, frozenLength);
        }
        return Reflect.get(target, property, target) as unknown;
      },
    });
    const buffer = new Proxy(terminal.buffer, {
      get(target, property) {
        if (property === "active") return activeView;
        return Reflect.get(target, property, target) as unknown;
      },
    });
    return new Proxy(terminal, {
      get(target, property) {
        if (property === "buffer") return buffer;
        return Reflect.get(target, property, target) as unknown;
      },
    });
  }, [terminalRef, xtermHostRef]);

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

  const resolveManagedSelection = useCallback(
    (
      range: PtySelectionRange,
      explicitPathAction?: PtySelectionPathAction | null,
    ): TerminalSelectionResult | null => {
      captureSelectionLines(range);
      const terminal = getSelectionTerminalView();
      if (!terminal) return null;
      const selected = resolveTerminalRange({
        terminal,
        anchor: toTerminalPoint(range.anchor),
        focus: toTerminalPoint(range.focus),
        columnMode: range.columnMode,
      });
      if (!selected) return null;
      selectedPtyTextRef.current = selected.text;
      setSelectedPathAction(selected.text, explicitPathAction);
      return selected;
    },
    [captureSelectionLines, getSelectionTerminalView, setSelectedPathAction],
  );

  const refreshCurrentSelection = useCallback((): TerminalSelectionResult | null => {
    const range = getPtyManagedSelectionRange(managedStateRef.current);
    return range ? resolveManagedSelection(range) : null;
  }, [resolveManagedSelection]);

  const presentRange = useCallback(
    (range: PtySelectionRange, presentation: SelectionPresentation): boolean => {
      if (presentation.toolbar === "hide") setToolbarPresentation("hide");
      let pathAction: PtySelectionPathAction | null = null;
      if (presentation.toolbar === "hide") {
        // Pointer/handle autoscroll can span the full 5000-line scrollback. Painting a range only
        // needs its endpoint lines; rebuilding the entire copied string on every animation frame
        // makes a long selection progressively slower. Resolve text once the gesture commits or
        // at the actual copy/action boundary instead.
        captureSelectionLines(range);
        const terminal = getSelectionTerminalView();
        if (
          !terminal ||
          range.anchor.column >= terminal.cols ||
          range.focus.column >= terminal.cols ||
          !terminal.buffer.active.getLine(range.anchor.row) ||
          !terminal.buffer.active.getLine(range.focus.row)
        ) {
          return false;
        }
        selectedPtyTextRef.current = "";
        selectedPathActionRef.current = null;
        setPtySelectionPathAction(null);
      } else {
        const selected = resolveManagedSelection(range, presentation.explicitPathAction);
        if (!selected) return false;
        pathAction = selectedPathActionRef.current;
      }

      ensureOverlay()?.render(range);
      selectionUsesHandlesRef.current = presentation.handles;
      const handles = presentation.handles ? getSelectionHandles(range) : null;
      setPtySelectionHandles(handles);

      if (presentation.toolbar === "hide") {
        setPtySelectionToolbar(null);
      } else if (presentation.toolbar === "path-only" && !pathAction) {
        setToolbarPresentation("hide");
        setPtySelectionToolbar(null);
      } else if (handles) {
        setToolbarPresentation(presentation.toolbar);
        setPtySelectionToolbar(getToolbarPositionForVisibleSelectionHandles(handles));
      } else if (presentation.clientPoint) {
        setToolbarPresentation(presentation.toolbar);
        setPtySelectionToolbar(
          getToolbarPosition(presentation.clientPoint.clientX, presentation.clientPoint.clientY),
        );
      } else {
        setToolbarPresentation("hide");
        setPtySelectionToolbar(null);
      }
      return true;
    },
    [
      ensureOverlay,
      captureSelectionLines,
      getSelectionTerminalView,
      getSelectionHandles,
      getToolbarPosition,
      getToolbarPositionForVisibleSelectionHandles,
      resolveManagedSelection,
      setToolbarPresentation,
    ],
  );

  const releaseCommittedSelectionMarkers = useCallback((): void => {
    const binding = committedSelectionMarkersRef.current;
    if (!binding) return;
    committedSelectionMarkersRef.current = null;
    for (const subscription of binding.subscriptions) subscription.dispose();
    binding.anchor?.dispose();
    binding.focus?.dispose();
  }, []);

  const clearSelectionVisuals = useCallback((): void => {
    overlayRef.current?.render(null);
    selectionUsesHandlesRef.current = false;
    selectedPathActionRef.current = null;
    selectedPtyTextRef.current = "";
    setToolbarPresentation("hide");
    setPtySelectionToolbar(null);
    setPtySelectionHandles(null);
    setPtySelectionPathAction(null);
  }, [setToolbarPresentation]);

  const clearManagedPtySelection = useCallback((): void => {
    stopDesktopSelectionRef.current?.();
    stopPtySelectionGestureRef.current?.();
    managedStateRef.current = reducePtyManagedSelection(managedStateRef.current, {
      type: "clear-selection",
    });
    selectionLinesRef.current = new Map();
    releaseCommittedSelectionMarkers();
    longPressCandidateRef.current = null;
    longPressFixedEndpointRef.current = null;
    handleDragRestoreRef.current = null;
    activeHandleDragKindRef.current = null;
    overlayRef.current?.dispose();
    overlayRef.current = null;
    overlayTerminalRef.current = null;
    clearSelectionVisuals();
  }, [clearSelectionVisuals, releaseCommittedSelectionMarkers]);

  const clearPtySelection = useCallback((): void => {
    clearManagedPtySelection();
    terminalRef.current?.clearSelection();
  }, [clearManagedPtySelection, terminalRef]);

  const getPointAtClient = useCallback(
    (clientX: number, clientY: number, clampToBuffer = false): TerminalSelectionPoint | null => {
      const terminal = terminalRef.current;
      const host = xtermHostRef.current;
      if (!terminal || !host) return null;
      return getTerminalPointAtClient({
        terminal,
        host,
        clientX,
        clientY,
        clampToBuffer,
      });
    },
    [terminalRef, xtermHostRef],
  );

  const refreshSelectionHandles = useCallback((): void => {
    if (!selectionUsesHandlesRef.current) return;
    const range = getPtyManagedSelectionRange(managedStateRef.current);
    if (!range) {
      setPtySelectionHandles(null);
      setPtySelectionToolbar(null);
      return;
    }
    captureSelectionLines(range);
    ensureOverlay()?.render(range);
    const handles = getSelectionHandles(range);
    setPtySelectionHandles(handles);
    if (!handles) {
      setPtySelectionToolbar(null);
      return;
    }
    const toolbarMode = toolbarPresentationRef.current;
    setPtySelectionToolbar(
      toolbarMode !== "hide" &&
        !toolbarScrollSuppressedRef.current &&
        (toolbarMode !== "path-only" || selectedPathActionRef.current)
        ? getToolbarPositionForVisibleSelectionHandles(handles)
        : null,
    );
  }, [
    captureSelectionLines,
    ensureOverlay,
    getSelectionHandles,
    getToolbarPositionForVisibleSelectionHandles,
  ]);

  const bindCommittedSelectionMarkers = useCallback(
    (range: PtySelectionRange): boolean => {
      releaseCommittedSelectionMarkers();
      const terminal = terminalRef.current;
      if (!terminal) return false;
      const buffer = terminal.buffer.active;
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (buffer.type === "alternate") {
        const binding: CommittedSelectionMarkerBinding = {
          terminal,
          buffer,
          cols,
          rows,
          anchor: null,
          focus: null,
          subscriptions: [],
          sync: () => undefined,
        };
        const invalidate = (): void => {
          if (committedSelectionMarkersRef.current !== binding) return;
          releaseCommittedSelectionMarkers();
          clearPtySelection();
        };
        binding.sync = (): void => {
          if (committedSelectionMarkersRef.current !== binding) return;
          if (
            terminalRef.current !== terminal ||
            terminal.buffer.active !== buffer ||
            terminal.cols !== cols ||
            terminal.rows !== rows
          ) {
            invalidate();
          }
        };
        committedSelectionMarkersRef.current = binding;
        binding.subscriptions.push(
          terminal.onResize(binding.sync),
          // onBufferChange is a row-space identity boundary even when xterm resets normal ->
          // normal and reuses the same public BufferApiView object.
          terminal.buffer.onBufferChange(invalidate),
        );
        return true;
      }

      const anchor = registerMarkerAtBufferRow(terminal, range.anchor.row);
      if (!anchor) return false;
      const focus = registerMarkerAtBufferRow(terminal, range.focus.row);
      if (
        !focus ||
        terminal.buffer.active !== buffer ||
        anchor.isDisposed ||
        anchor.line !== range.anchor.row ||
        focus.isDisposed ||
        focus.line !== range.focus.row
      ) {
        anchor.dispose();
        focus?.dispose();
        return false;
      }

      const binding: CommittedSelectionMarkerBinding = {
        terminal,
        buffer,
        cols,
        rows,
        anchor,
        focus,
        subscriptions: [],
        sync: () => undefined,
      };
      const invalidate = (): void => {
        if (committedSelectionMarkersRef.current !== binding) return;
        releaseCommittedSelectionMarkers();
        clearPtySelection();
      };
      binding.sync = (): void => {
        if (committedSelectionMarkersRef.current !== binding) return;
        if (
          terminalRef.current !== terminal ||
          terminal.buffer.active !== buffer ||
          terminal.cols !== cols ||
          anchor.isDisposed ||
          focus.isDisposed ||
          anchor.line < 0 ||
          focus.line < 0
        ) {
          invalidate();
          return;
        }

        const state = managedStateRef.current;
        // A press/drag may temporarily retain the previously committed range for cancellation.
        // Its marker rows are synchronized once that gesture resolves back to `selected`.
        if (state.phase !== "selected") return;
        if (state.range.anchor.row === anchor.line && state.range.focus.row === focus.line) return;

        const anchorDelta = anchor.line - state.range.anchor.row;
        const focusDelta = focus.line - state.range.focus.row;
        if (anchorDelta !== focusDelta) {
          invalidate();
          return;
        }
        const rebasedRange: PtySelectionRange = {
          ...state.range,
          anchor: { ...state.range.anchor, row: anchor.line },
          focus: { ...state.range.focus, row: focus.line },
        };
        managedStateRef.current = reducePtyManagedSelection(state, {
          type: "set-selection",
          range: rebasedRange,
        });
        selectionLinesRef.current = rebasePtySelectionLineSnapshots(
          selectionLinesRef.current,
          anchorDelta,
        );
        if (longPressFixedEndpointRef.current) {
          longPressFixedEndpointRef.current = {
            ...longPressFixedEndpointRef.current,
            row: longPressFixedEndpointRef.current.row + anchorDelta,
          };
        }
        if (handleDragRestoreRef.current) {
          const rebasedRestore = rebasePtySelectionRangeRows(
            handleDragRestoreRef.current.range,
            anchorDelta,
          );
          if (!rebasedRestore) {
            invalidate();
            return;
          }
          handleDragRestoreRef.current = {
            range: rebasedRestore,
            lines: rebasePtySelectionLineSnapshots(handleDragRestoreRef.current.lines, anchorDelta),
          };
        }
        ensureOverlay()?.render(rebasedRange);
        refreshSelectionHandles();
      };

      committedSelectionMarkersRef.current = binding;
      binding.subscriptions.push(
        anchor.onDispose(invalidate),
        focus.onDispose(invalidate),
        terminal.onWriteParsed(binding.sync),
        terminal.onResize(binding.sync),
        terminal.buffer.onBufferChange(invalidate),
      );
      return true;
    },
    [
      clearPtySelection,
      ensureOverlay,
      refreshSelectionHandles,
      releaseCommittedSelectionMarkers,
      terminalRef,
    ],
  );

  const syncSelectionHandleElements = useCallback((): void => {
    if (!selectionUsesHandlesRef.current) return;
    const range = getPtyManagedSelectionRange(managedStateRef.current);
    const layer = selectionHandleLayerRef.current;
    const handles = range ? getSelectionHandles(range) : null;
    if (!layer) return;
    const geometry = handles ? getSelectionHandleViewportGeometry(handles) : null;

    for (const kind of ["anchor", "focus"] as const) {
      const element = layer.querySelector<HTMLElement>(
        `[data-slot="pty-selection-handle"][data-kind="${kind}"]`,
      );
      if (!element) continue;
      const position = handles?.[kind];
      if (!position) {
        if (element.style.visibility !== "hidden") element.style.visibility = "hidden";
        if (element.style.pointerEvents !== "none") element.style.pointerEvents = "none";
        continue;
      }
      const visible = geometry?.visible[kind] === true || activeHandleDragKindRef.current === kind;
      const transform = `translate3d(${position.left}px, ${position.top}px, 0) translate(-50%, -50%)`;
      const visibility = visible ? "visible" : "hidden";
      const pointerEvents = visible ? "auto" : "none";
      if (element.style.transform !== transform) element.style.transform = transform;
      if (element.style.visibility !== visibility) element.style.visibility = visibility;
      if (element.style.pointerEvents !== pointerEvents) {
        element.style.pointerEvents = pointerEvents;
      }
    }
  }, [getSelectionHandleViewportGeometry, getSelectionHandles, selectionHandleLayerRef]);

  const setManagedSelection = useCallback(
    (
      selected: TerminalSelectionResult,
      presentation: SelectionPresentation,
      resetSelectionLines = false,
    ): PtySelectionRange | null => {
      const range: PtySelectionRange = {
        anchor: toTerminalPoint(selected.anchor),
        focus: toTerminalPoint(selected.focus),
        columnMode: selected.columnMode,
      };
      managedStateRef.current = reducePtyManagedSelection(managedStateRef.current, {
        type: "set-selection",
        range,
      });
      if (resetSelectionLines) selectionLinesRef.current = new Map();
      if (!presentRange(range, presentation)) {
        clearPtySelection();
        return null;
      }
      if (!bindCommittedSelectionMarkers(range)) {
        clearPtySelection();
        return null;
      }
      return range;
    },
    [bindCommittedSelectionMarkers, clearPtySelection, presentRange],
  );

  useEffect(
    () => () => {
      releaseCommittedSelectionMarkers();
    },
    [releaseCommittedSelectionMarkers],
  );

  useEffect(() => {
    overlayRef.current?.dispose();
    overlayRef.current = null;
    overlayTerminalRef.current = null;
    return () => {
      overlayRef.current?.dispose();
      overlayRef.current = null;
      overlayTerminalRef.current = null;
    };
  }, [containerEl]);

  // Desktop selection is fully application-owned. Capture mousedown before xterm's listeners so
  // SelectionService never starts its private 50 ms timer. Pointer movement updates one absolute
  // buffer range; only this loop may autoscroll the outer container. Linkifier candidates are read
  // before the event is stopped and activated explicitly on the browser's real mouseup.
  useEffect(() => {
    if (!containerEl) return;
    const document = containerEl.ownerDocument;
    const effectTerminal = terminalRef.current;
    let gesture: DesktopSelectionGesture | null = null;
    let nextGestureId = 1;
    let autoscrollFrame: number | null = null;
    let managedCopyEventHandled = false;
    let gestureMarkerBinding: {
      terminal: Terminal;
      buffer: IBuffer;
      cols: number;
      rows: number;
      marker: IMarker | null;
      markerLine: number;
      subscriptions: IDisposable[];
    } | null = null;
    let cancelGestureForBufferMutation = (): void => {};

    const stopGestureMarker = (): void => {
      const binding = gestureMarkerBinding;
      if (!binding) return;
      gestureMarkerBinding = null;
      for (const subscription of binding.subscriptions) subscription.dispose();
      binding.marker?.dispose();
    };

    const stopAutoscroll = (): void => {
      if (autoscrollFrame === null) return;
      cancelAnimationFrame(autoscrollFrame);
      autoscrollFrame = null;
    };
    const stopDesktop = (): void => {
      gesture = null;
      stopAutoscroll();
      stopGestureMarker();
    };
    stopDesktopSelectionRef.current = stopDesktop;

    const presentDesktopState = (clientX: number, clientY: number): void => {
      const range = getPtyManagedSelectionRange(managedStateRef.current);
      if (!range) return;
      if (gesture) selectionLinesRef.current = gesture.selectionLines;
      presentRange(range, {
        handles: false,
        toolbar: "hide",
        clientPoint: { clientX, clientY },
      });
    };

    const startGestureMarker = (terminal: Terminal, row: number): boolean => {
      stopGestureMarker();
      const buffer = terminal.buffer.active;
      const marker = buffer.type === "normal" ? registerMarkerAtBufferRow(terminal, row) : null;
      if (buffer.type === "normal" && !marker) return false;
      const binding = {
        terminal,
        buffer,
        cols: terminal.cols,
        rows: terminal.rows,
        marker,
        markerLine: marker?.line ?? row,
        subscriptions: [] as IDisposable[],
      };
      const invalidate = (): void => {
        if (gestureMarkerBinding !== binding) return;
        stopGestureMarker();
        cancelGestureForBufferMutation();
      };
      const sync = (): void => {
        if (gestureMarkerBinding !== binding || !gesture) return;
        if (
          terminalRef.current !== terminal ||
          terminal.buffer.active !== buffer ||
          terminal.cols !== binding.cols ||
          (buffer.type === "alternate" && terminal.rows !== binding.rows) ||
          marker?.isDisposed ||
          (marker !== null && marker.line < 0)
        ) {
          invalidate();
          return;
        }
        // Alternate-buffer rows never trim, but the active buffer and column geometry still own
        // their coordinates. The subscriptions above invalidate the gesture if either changes.
        if (!marker) return;
        const delta = marker.line - binding.markerLine;
        if (delta === 0) return;
        binding.markerLine = marker.line;
        managedStateRef.current = rebasePtyManagedSelectionRows(managedStateRef.current, delta);
        gesture.initialRange = gesture.initialRange
          ? rebasePtySelectionRangeRows(gesture.initialRange, delta)
          : null;
        gesture.selectionLines = rebasePtySelectionLineSnapshots(gesture.selectionLines, delta);
        gesture.selectionLinesBeforePress = rebasePtySelectionLineSnapshots(
          gesture.selectionLinesBeforePress,
          delta,
        );
        selectionLinesRef.current = rebasePtySelectionLineSnapshots(
          selectionLinesRef.current,
          delta,
        );
        if (
          managedStateRef.current.phase !== "pressed" &&
          managedStateRef.current.phase !== "selecting"
        ) {
          invalidate();
          return;
        }
        presentDesktopState(gesture.lastX, gesture.lastY);
      };
      gestureMarkerBinding = binding;
      binding.subscriptions.push(
        terminal.onWriteParsed(sync),
        terminal.onResize(sync),
        terminal.buffer.onBufferChange(invalidate),
      );
      if (marker) binding.subscriptions.push(marker.onDispose(invalidate));
      return true;
    };

    const resolveSelectionUnitAtPoint = (
      point: TerminalSelectionPoint,
      unit: DesktopSelectionGesture["unit"],
    ): TerminalSelectionResult | null => {
      const terminal = getSelectionTerminalView();
      if (!terminal) return null;
      if (unit === "line") return resolveTerminalLineAtBufferPoint({ terminal, point });
      if (unit === "word") {
        return (
          resolveTerminalPathLinkAtBufferPoint({ terminal, point }) ??
          resolveTerminalInitialRangeAtBufferPoint({ terminal, point })
        );
      }
      return null;
    };

    const resolveGestureRangeAtPoint = (
      point: TerminalSelectionPoint | null,
    ): PtySelectionRange | null => {
      if (!gesture || !point || gesture.unit === "cell" || !gesture.initialRange) return null;
      const target = resolveSelectionUnitAtPoint(point, gesture.unit);
      if (!target) return gesture.initialRange;

      const initial = normalizeManagedRange(gesture.initialRange);
      const targetRange = normalizeManagedRange({ anchor: target.anchor, focus: target.focus });
      if (compareTerminalPoints(targetRange.end, initial.start) < 0) {
        return { anchor: initial.end, focus: targetRange.start };
      }
      if (compareTerminalPoints(targetRange.start, initial.end) > 0) {
        return { anchor: initial.start, focus: targetRange.end };
      }
      return gesture.initialRange;
    };

    const updateAutoscrolledFocus = (): void => {
      if (!gesture) return;
      const point = getPointAtClient(gesture.lastX, gesture.lastY, true);
      managedStateRef.current = reducePtyManagedSelection(managedStateRef.current, {
        type: "selection-autoscroll",
        pointerId: gesture.id,
        bufferPoint: point,
        range: resolveGestureRangeAtPoint(point),
      });
      presentDesktopState(gesture.lastX, gesture.lastY);
    };

    const autoscrollTick = (): void => {
      autoscrollFrame = null;
      if (!gesture || !canPtyManagedSelectionAutoscroll(managedStateRef.current)) return;
      const rect = containerEl.getBoundingClientRect();
      const { dx, dy } = getEdgeAutoscrollDelta({
        pointerX: gesture.lastX,
        pointerY: gesture.lastY,
        rect,
        scrollLeft: containerEl.scrollLeft,
        scrollTop: containerEl.scrollTop,
        scrollWidth: containerEl.scrollWidth,
        scrollHeight: containerEl.scrollHeight,
        clientWidth: containerEl.clientWidth,
        clientHeight: containerEl.clientHeight,
      });

      const previousLeft = containerEl.scrollLeft;
      const previousTop = containerEl.scrollTop;
      if (dx !== 0) {
        scrollControllerRef.current?.markHorizontalScrollIntent(
          `managedSelectionAutoscroll dx=${Math.round(dx)}`,
        );
        containerEl.scrollLeft += dx;
      }
      if (dy !== 0) {
        scrollControllerRef.current?.markSelectionAutoscrollIntent(
          `managedSelectionAutoscroll dy=${Math.round(dy)}`,
        );
        containerEl.scrollTop += dy;
      }
      if (containerEl.scrollLeft !== previousLeft || containerEl.scrollTop !== previousTop) {
        updateAutoscrolledFocus();
      }
      autoscrollFrame = requestAnimationFrame(autoscrollTick);
    };

    const ensureAutoscroll = (): void => {
      if (autoscrollFrame !== null) return;
      if (!canPtyManagedSelectionAutoscroll(managedStateRef.current)) return;
      autoscrollFrame = requestAnimationFrame(autoscrollTick);
    };

    const finishDesktopGesture = (
      reason: "release" | "cancel",
      clientX: number,
      clientY: number,
    ): void => {
      if (!gesture) return;
      const currentGesture = gesture;
      const previousState = managedStateRef.current;
      const result =
        reason === "cancel"
          ? "preserve-selection"
          : previousState.phase === "pressed"
            ? currentGesture.shiftExtend || currentGesture.unit !== "cell"
              ? "commit-selection"
              : "clear-on-click"
            : "commit-selection";
      managedStateRef.current = reducePtyManagedSelection(previousState, {
        type: "gesture-finish",
        pointerId: currentGesture.id,
        result,
      });
      selectionLinesRef.current =
        result === "preserve-selection"
          ? currentGesture.selectionLinesBeforePress
          : result === "commit-selection"
            ? currentGesture.selectionLines
            : new Map();
      stopDesktop();

      if (result === "preserve-selection") {
        committedSelectionMarkersRef.current?.sync();
      }
      const range = getPtyManagedSelectionRange(managedStateRef.current);
      if (!range) {
        selectionLinesRef.current = new Map();
        releaseCommittedSelectionMarkers();
        clearSelectionVisuals();
        return;
      }
      pruneSelectionLines(range);
      const presentation: SelectionPresentation = {
        handles: false,
        toolbar: "path-only",
        clientPoint: { clientX, clientY },
      };
      if (!presentRange(range, presentation)) {
        clearPtySelection();
        return;
      }
      if (result === "commit-selection" && !bindCommittedSelectionMarkers(range)) {
        clearPtySelection();
      }
    };
    cancelGestureForBufferMutation = (): void => {
      if (!gesture) return;
      terminalRef.current?.clearSelection();
      finishDesktopGesture("cancel", gesture.lastX, gesture.lastY);
    };

    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      const terminal = terminalRef.current;
      const target = event.target;
      if (!terminal || !(target instanceof Element)) return;
      const point = getPointAtClient(event.clientX, event.clientY, false);
      // Live-backfill rows are painted above `.xterm-screen` with pointer-events disabled. The
      // browser therefore reports the underlying spacer as the event target even though the user
      // pressed a real terminal cell. Geometry, not `closest('.xterm')`, is authoritative there.
      if (!target.closest(".xterm") && !point) return;
      const forceSelection = shouldForceDesktopSelection(terminal, event);
      const hoveredLink = captureXtermDesktopLinkCandidate(terminal, event);
      const ownsTrackedLink =
        terminal.modes.mouseTrackingMode !== "none" &&
        !forceSelection &&
        (event.metaKey || event.ctrlKey) &&
        hoveredLink !== null;
      if (!shouldOwnDesktopSelection(terminal, event) && !ownsTrackedLink) return;

      if (gesture) finishDesktopGesture("cancel", gesture.lastX, gesture.lastY);

      event.preventDefault();
      event.stopImmediatePropagation();
      terminal.focus();
      terminal.clearSelection();
      const previousRange = getPtyManagedSelectionRange(managedStateRef.current);
      const selectionLinesBeforePress = new Map(selectionLinesRef.current);
      const id = nextGestureId++;
      const shiftExtend = event.shiftKey && previousRange !== null && point !== null;
      const columnMode =
        previousRange && shiftExtend
          ? previousRange.columnMode
          : shouldColumnSelectDesktop(terminal, event);
      const unit: DesktopSelectionGesture["unit"] = shiftExtend
        ? "cell"
        : event.detail === 3
          ? "line"
          : event.detail === 2
            ? "word"
            : "cell";
      const selectionLines = shiftExtend ? new Map(selectionLinesBeforePress) : new Map();
      selectionLinesRef.current = selectionLines;
      const resolvedUnit = point ? resolveSelectionUnitAtPoint(point, unit) : null;
      const initialRange: PtySelectionRange | null = shiftExtend
        ? {
            anchor: previousRange.anchor,
            focus: point,
            columnMode: previousRange.columnMode,
          }
        : resolvedUnit
          ? {
              anchor: toTerminalPoint(resolvedUnit.anchor),
              focus: toTerminalPoint(resolvedUnit.focus),
            }
          : null;
      managedStateRef.current = reducePtyManagedSelection(managedStateRef.current, {
        type: "pointer-press",
        candidate: {
          pointerId: id,
          client: { x: event.clientX, y: event.clientY },
          bufferPoint: point,
          columnMode,
        },
      });
      if (initialRange) {
        managedStateRef.current = reducePtyManagedSelection(managedStateRef.current, {
          type: "resolve-press-range",
          pointerId: id,
          range: initialRange,
        });
        presentDesktopState(event.clientX, event.clientY);
      }
      gesture = {
        id,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        shiftExtend,
        unit,
        initialRange,
        linkCandidate:
          event.detail === 1 && !shiftExtend && !forceSelection && !columnMode ? hoveredLink : null,
        selectionLinesBeforePress,
        selectionLines,
      };
      if (point && !startGestureMarker(terminal, point.row)) {
        cancelGestureForBufferMutation();
        return;
      }
      if (shiftExtend || unit !== "cell") {
        queueMicrotask(() => {
          if (terminalRef.current === terminal) terminal.clearSelection();
        });
      }
    };

    const onMouseMove = (event: MouseEvent): void => {
      if (!gesture) return;
      if (event.buttons === 0) {
        // Chrome can lose mouseup when the pointer leaves the window. A later buttons=0 move is a
        // recovered release: keep the range already established by the drag, then stop ownership.
        terminalRef.current?.clearSelection();
        finishDesktopGesture("release", event.clientX, event.clientY);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      const state = managedStateRef.current;
      if (
        state.phase === "pressed" &&
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) <
          DESKTOP_DRAG_THRESHOLD_PX
      ) {
        return;
      }
      terminalRef.current?.clearSelection();
      gesture.linkCandidate = null;
      const point = getPointAtClient(event.clientX, event.clientY, true);
      managedStateRef.current = reducePtyManagedSelection(state, {
        type: "pointer-move",
        pointerId: gesture.id,
        client: { x: event.clientX, y: event.clientY },
        bufferPoint: point,
        range: resolveGestureRangeAtPoint(point),
      });
      if (managedStateRef.current.phase === "selecting") {
        presentDesktopState(event.clientX, event.clientY);
        ensureAutoscroll();
      }
    };

    const onMouseUp = (event: MouseEvent): void => {
      if (!gesture || event.button !== 0) return;
      const wasStationaryCellPress =
        managedStateRef.current.phase === "pressed" &&
        gesture.unit === "cell" &&
        !gesture.shiftExtend;
      const linkCandidate = wasStationaryCellPress ? gesture.linkCandidate : null;
      event.preventDefault();
      event.stopImmediatePropagation();
      terminalRef.current?.clearSelection();
      finishDesktopGesture("release", event.clientX, event.clientY);
      const activated = linkCandidate?.activateOnMouseUp(event) === true;
      if (!activated && wasStationaryCellPress && linkCandidate === null) {
        onTap?.({
          clientX: event.clientX,
          clientY: event.clientY,
          pointerType: "mouse",
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        });
      }
      terminalRef.current?.focus();
    };

    const onWindowBlur = (): void => {
      if (!gesture) return;
      terminalRef.current?.clearSelection();
      finishDesktopGesture("cancel", gesture.lastX, gesture.lastY);
    };

    const onPointerCancel = (event: PointerEvent): void => {
      if (!gesture || event.pointerType !== "mouse") return;
      terminalRef.current?.clearSelection();
      finishDesktopGesture("cancel", event.clientX, event.clientY);
    };

    const onVisibilityChange = (): void => {
      if (!gesture || document.visibilityState !== "hidden") return;
      terminalRef.current?.clearSelection();
      finishDesktopGesture("cancel", gesture.lastX, gesture.lastY);
    };

    const onPageHide = (): void => {
      if (!gesture) return;
      terminalRef.current?.clearSelection();
      finishDesktopGesture("cancel", gesture.lastX, gesture.lastY);
    };

    const onCopy = (event: ClipboardEvent): void => {
      const selected = refreshCurrentSelection()?.text ?? "";
      if (!selected || !event.clipboardData) return;
      managedCopyEventHandled = true;
      event.clipboardData.setData("text/plain", selected);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!getPtyManagedSelectionRange(managedStateRef.current)) return;
      if (isCopyShortcut(event)) {
        const selected = refreshCurrentSelection()?.text ?? "";
        if (!selected) return;
        // Managed ranges deliberately do not populate xterm's private SelectionService. On
        // Ctrl+C, xterm would therefore treat the key as raw SIGINT input and prevent the
        // browser's copy event. Own the shortcut on every desktop platform and preserve the
        // committed range after writing it to the clipboard.
        event.preventDefault();
        event.stopImmediatePropagation();
        managedCopyEventHandled = false;
        try {
          document.execCommand("copy");
        } catch {
          // Fall through to the Clipboard API / hidden-textarea compatibility path below.
        }
        if (!managedCopyEventHandled) {
          const activeElement =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          void copyText(selected, { allowLegacyFallback: true }).finally(() => {
            if (
              activeElement?.isConnected &&
              (document.activeElement === document.body || document.activeElement === null)
            ) {
              activeElement.focus({ preventScroll: true });
            }
          });
        }
        return;
      }
      if (
        event.key === "Shift" ||
        event.key === "Control" ||
        event.key === "Meta" ||
        event.key === "Alt"
      ) {
        return;
      }
      clearPtySelection();
    };

    const onContextMenu = (event: MouseEvent): void => {
      const terminal = terminalRef.current;
      const target = event.target;
      const point = getPointAtClient(event.clientX, event.clientY, false);
      if (!terminal || !(target instanceof Element)) return;
      if (!target.closest(".xterm") && !point) return;
      const currentRange = getPtyManagedSelectionRange(managedStateRef.current);
      if (point && (!currentRange || !managedRangeContainsPoint(currentRange, point))) {
        const previousSelectionLines = selectionLinesRef.current;
        selectionLinesRef.current = new Map();
        const selectionTerminal = getSelectionTerminalView();
        if (!selectionTerminal) {
          selectionLinesRef.current = previousSelectionLines;
          return;
        }
        const pathSelection = resolveTerminalPathLinkAtBufferPoint({
          terminal: selectionTerminal,
          point,
        });
        const selected =
          pathSelection ??
          resolveTerminalInitialRangeAtBufferPoint({ terminal: selectionTerminal, point });
        if (selected) {
          setManagedSelection(
            selected,
            {
              handles: false,
              toolbar: "hide",
              clientPoint: { clientX: event.clientX, clientY: event.clientY },
              explicitPathAction: pathSelection?.pathAction,
            },
            true,
          );
        } else selectionLinesRef.current = previousSelectionLines;
      }

      const range = getPtyManagedSelectionRange(managedStateRef.current);
      if (!range) return;
      const selected = refreshCurrentSelection()?.text ?? "";
      const textarea =
        terminal.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!textarea || !screen) return;

      // xterm's native context-menu path reads its private SelectionService. Feed the browser's
      // Copy action from the managed range instead and stop that later handler from replacing the
      // helper value with an empty native selection.
      event.stopImmediatePropagation();
      const screenRect = screen.getBoundingClientRect();
      Object.assign(textarea.style, {
        width: "20px",
        height: "20px",
        left: `${event.clientX - screenRect.left - 10}px`,
        top: `${event.clientY - screenRect.top - 10}px`,
        zIndex: "1000",
      });
      textarea.value = selected;
      textarea.focus({ preventScroll: true });
      textarea.select();
    };

    containerEl.addEventListener("mousedown", onMouseDown, true);
    containerEl.addEventListener("copy", onCopy, true);
    containerEl.addEventListener("keydown", onKeyDown, true);
    containerEl.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      if (gesture) {
        effectTerminal?.clearSelection();
        finishDesktopGesture("cancel", gesture.lastX, gesture.lastY);
      } else stopDesktop();
      if (stopDesktopSelectionRef.current === stopDesktop) stopDesktopSelectionRef.current = null;
      containerEl.removeEventListener("mousedown", onMouseDown, true);
      containerEl.removeEventListener("copy", onCopy, true);
      containerEl.removeEventListener("keydown", onKeyDown, true);
      containerEl.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [
    bindCommittedSelectionMarkers,
    clearPtySelection,
    clearSelectionVisuals,
    containerEl,
    getPointAtClient,
    getSelectionTerminalView,
    onTap,
    presentRange,
    pruneSelectionLines,
    refreshCurrentSelection,
    releaseCommittedSelectionMarkers,
    scrollControllerRef,
    setManagedSelection,
    terminalRef,
  ]);

  useLayoutEffect(() => {
    if (!ptySelectionToolbar && !ptySelectionHandles && !ptySelectionPathAction) return;
    const clearUnlessSelectionControl = (event: Event): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-slot="pty-selection-toolbar"], [data-slot="pty-selection-handle"]')
      ) {
        return;
      }
      const pointerType =
        "pointerType" in event && typeof event.pointerType === "string" ? event.pointerType : null;
      const targetIsTerminal = target instanceof Element && target.closest(".xterm") !== null;
      const targetIsTerminalSurface =
        targetIsTerminal ||
        (target instanceof Element &&
          target.closest('[data-slot="pty-spacer"], [data-slot="pty-host"]') !== null);
      const targetIsProjectedTerminalCell =
        !targetIsTerminal &&
        targetIsTerminalSurface &&
        "clientX" in event &&
        typeof event.clientX === "number" &&
        "clientY" in event &&
        typeof event.clientY === "number" &&
        getPointAtClient(event.clientX, event.clientY, false) !== null;
      const targetIsScrollbar =
        target instanceof Element &&
        target.closest('[data-slot="pty-scrollbar"], [data-slot="pty-horizontal-scrollbar"]') !==
          null;
      if (
        shouldDeferPtySelectionDismissOnInteractionStart({
          hasManagedSelection: getPtyManagedSelectionRange(managedStateRef.current) !== null,
          eventType: event.type,
          pointerType,
          targetIsScrollSurface:
            targetIsScrollbar ||
            (targetIsTerminalSurface && (event.type === "touchstart" || pointerType === "touch")),
        })
      ) {
        return;
      }
      if (pointerType === "mouse" && (targetIsTerminal || targetIsProjectedTerminalCell)) return;
      clearPtySelection();
    };
    document.addEventListener("pointerdown", clearUnlessSelectionControl, true);
    document.addEventListener("touchstart", clearUnlessSelectionControl, true);
    return () => {
      document.removeEventListener("pointerdown", clearUnlessSelectionControl, true);
      document.removeEventListener("touchstart", clearUnlessSelectionControl, true);
    };
  }, [
    clearPtySelection,
    getPointAtClient,
    ptySelectionHandles,
    ptySelectionPathAction,
    ptySelectionToolbar,
  ]);

  const hasPtySelectionHandles = ptySelectionHandles !== null;
  useLayoutEffect(() => {
    if (!hasPtySelectionHandles) return;
    syncSelectionHandleElements();
  }, [hasPtySelectionHandles, ptySelectionHandles, syncSelectionHandleElements]);

  useLayoutEffect(() => {
    if (!hasPtySelectionHandles || !containerEl) return;
    const terminal = terminalRef.current;
    syncSelectionHandleElements();
    containerEl.addEventListener("scroll", syncSelectionHandleElements, { passive: true });
    const scrollDisposable = terminal?.onScroll(syncSelectionHandleElements);
    const renderDisposable = terminal?.onRender(syncSelectionHandleElements);
    const resizeDisposable = terminal?.onResize(syncSelectionHandleElements);
    const resizeObserver = new ResizeObserver(syncSelectionHandleElements);
    resizeObserver.observe(containerEl);
    const layer = selectionHandleLayerRef.current;
    if (layer) resizeObserver.observe(layer);
    const host = xtermHostRef.current;
    if (host) resizeObserver.observe(host);
    return () => {
      containerEl.removeEventListener("scroll", syncSelectionHandleElements);
      scrollDisposable?.dispose();
      renderDisposable?.dispose();
      resizeDisposable?.dispose();
      resizeObserver.disconnect();
    };
  }, [
    containerEl,
    hasPtySelectionHandles,
    selectionHandleLayerRef,
    syncSelectionHandleElements,
    terminalRef,
    xtermHostRef,
  ]);

  useLayoutEffect(() => {
    const keyboardOffsetChanged = previousKeyboardOffsetRef.current !== keyboardOffset;
    previousKeyboardOffsetRef.current = keyboardOffset;
    if (keyboardOffsetChanged) {
      selectionViewportTransitionUntilRef.current =
        performance.now() + VIEWPORT_SELECTION_SETTLE_MS;
    }
    if (!hasPtySelectionHandles) return;
    scrollControllerRef.current?.relayout();
    refreshSelectionHandles();
    syncSelectionHandleElements();
  }, [
    hasPtySelectionHandles,
    keyboardOffset,
    refreshSelectionHandles,
    scrollControllerRef,
    syncSelectionHandleElements,
  ]);

  useEffect(() => {
    if (!hasPtySelectionHandles) return;
    const visualViewport = window.visualViewport;
    let raf = 0;
    let settleTimer = 0;
    const scheduleRefresh = (): void => {
      selectionViewportTransitionUntilRef.current =
        performance.now() + VIEWPORT_SELECTION_SETTLE_MS;
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      raf = requestAnimationFrame(() => {
        refreshSelectionHandles();
        syncSelectionHandleElements();
        settleTimer = window.setTimeout(() => {
          raf = requestAnimationFrame(() => {
            refreshSelectionHandles();
            syncSelectionHandleElements();
          });
        }, 160);
      });
    };

    refreshSelectionHandles();
    syncSelectionHandleElements();
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
  }, [hasPtySelectionHandles, refreshSelectionHandles, syncSelectionHandleElements]);

  const capturePtyLongPressCandidate = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      suppressPtyFocus({ blur: false });
      longPressCandidateRef.current = getPointAtClient(clientX, clientY, false);
    },
    [getPointAtClient, suppressPtyFocus],
  );

  const handlePtyLongPressStart = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const point = getPointAtClient(clientX, clientY, false) ?? longPressCandidateRef.current;
      terminal.clearSelection();
      if (!point) {
        clearPtySelection();
        return;
      }
      selectionLinesRef.current = new Map();
      const selectionTerminal = getSelectionTerminalView();
      if (!selectionTerminal) return;
      const pathSelection = resolveTerminalPathLinkAtBufferPoint({
        terminal: selectionTerminal,
        point,
      });
      const selected =
        pathSelection ??
        resolveTerminalInitialRangeAtBufferPoint({ terminal: selectionTerminal, point });
      if (!selected) {
        clearPtySelection();
        return;
      }
      longPressFixedEndpointRef.current = null;
      setManagedSelection(
        selected,
        {
          handles: true,
          toolbar: "hide",
          clientPoint: { clientX, clientY },
          explicitPathAction: pathSelection?.pathAction,
        },
        true,
      );
    },
    [
      clearPtySelection,
      getPointAtClient,
      getSelectionTerminalView,
      setManagedSelection,
      terminalRef,
    ],
  );

  const handlePtyLongPressMove = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): boolean => {
      const point = getPointAtClient(clientX, clientY, true);
      const current = getPtyManagedSelectionRange(managedStateRef.current);
      if (!point || !current) return false;
      if (!longPressFixedEndpointRef.current) {
        const { start, end } = normalizeManagedRange(current);
        const comparedToStart = compareTerminalPoints(point, start);
        const comparedToEnd = compareTerminalPoints(point, end);
        // Native touch streams often deliver a tiny move immediately after the long-press timer.
        // Do not collapse the initially selected word while that point is still inside it. The
        // first cell that actually leaves the range decides which opposite edge becomes fixed.
        if (comparedToStart >= 0 && comparedToEnd <= 0) return false;
        longPressFixedEndpointRef.current = toTerminalPoint(comparedToStart < 0 ? end : start);
      }
      const selected: TerminalSelectionResult = {
        anchor: longPressFixedEndpointRef.current,
        focus: point,
        text: "",
      };
      return (
        setManagedSelection(selected, {
          handles: true,
          toolbar: "hide",
          clientPoint: { clientX, clientY },
        }) !== null
      );
    },
    [getPointAtClient, setManagedSelection],
  );

  const showToolbarForCurrentSelection = useCallback(
    (clientPoint?: { clientX: number; clientY: number }): void => {
      const range = getPtyManagedSelectionRange(managedStateRef.current);
      if (!range) return;
      pruneSelectionLines(range);
      presentRange(range, { handles: true, toolbar: "show", clientPoint });
    },
    [presentRange, pruneSelectionLines],
  );

  const restoreToolbarAfterContainerScroll = useCallback((): void => {
    const toolbarMode = toolbarPresentationRef.current;
    if (toolbarMode === "hide" || activeHandleDragKindRef.current !== null) {
      return;
    }
    const range = getPtyManagedSelectionRange(managedStateRef.current);
    if (!range || !refreshCurrentSelection()) return;
    if (toolbarMode === "path-only" && !selectedPathActionRef.current) return;
    const handles = getSelectionHandles(range);
    setPtySelectionToolbar(handles ? getToolbarPositionForVisibleSelectionHandles(handles) : null);
  }, [getSelectionHandles, getToolbarPositionForVisibleSelectionHandles, refreshCurrentSelection]);

  useLayoutEffect(() => {
    if (!containerEl) return;
    const ownerDocument = containerEl.ownerDocument;
    const ownerWindow = ownerDocument.defaultView ?? window;
    let touchActive = false;

    const clearSettleTimer = (): void => {
      window.clearTimeout(toolbarScrollSettleTimerRef.current);
      toolbarScrollSettleTimerRef.current = 0;
    };
    const scheduleRestore = (): void => {
      clearSettleTimer();
      if (
        touchActive ||
        !toolbarScrollSuppressedRef.current ||
        toolbarPresentationRef.current === "hide" ||
        ownerDocument.visibilityState === "hidden"
      ) {
        return;
      }
      const generation = ++toolbarScrollGenerationRef.current;
      toolbarScrollSettleTimerRef.current = window.setTimeout(() => {
        toolbarScrollSettleTimerRef.current = 0;
        if (
          generation !== toolbarScrollGenerationRef.current ||
          touchActive ||
          toolbarPresentationRef.current === "hide" ||
          ownerDocument.visibilityState === "hidden"
        ) {
          return;
        }
        toolbarScrollSuppressedRef.current = false;
        restoreToolbarAfterContainerScroll();
      }, SELECTION_TOOLBAR_SCROLL_SETTLE_MS);
    };
    const onScroll = (): void => {
      if (toolbarPresentationRef.current === "hide") return;
      toolbarScrollSuppressedRef.current = true;
      setPtySelectionToolbar(null);
      scheduleRestore();
    };
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length === 0) return;
      touchActive = true;
      toolbarScrollGenerationRef.current += 1;
      clearSettleTimer();
    };
    const onTouchEnd = (event: TouchEvent): void => {
      if (event.touches.length > 0) return;
      touchActive = false;
      scheduleRestore();
    };
    const interruptTouch = (): void => {
      touchActive = false;
      toolbarScrollGenerationRef.current += 1;
      clearSettleTimer();
    };
    const onVisibilityChange = (): void => {
      if (ownerDocument.visibilityState === "hidden") interruptTouch();
      else scheduleRestore();
    };
    const onPageShow = (): void => scheduleRestore();

    containerEl.addEventListener("scroll", onScroll, { passive: true });
    containerEl.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    ownerDocument.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    ownerDocument.addEventListener("touchcancel", onTouchEnd, { passive: true, capture: true });
    ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
    ownerWindow.addEventListener("blur", interruptTouch);
    ownerWindow.addEventListener("focus", onPageShow);
    ownerWindow.addEventListener("pagehide", interruptTouch);
    ownerWindow.addEventListener("pageshow", onPageShow);
    return () => {
      toolbarScrollGenerationRef.current += 1;
      toolbarScrollSuppressedRef.current = false;
      clearSettleTimer();
      containerEl.removeEventListener("scroll", onScroll);
      containerEl.removeEventListener("touchstart", onTouchStart, true);
      ownerDocument.removeEventListener("touchend", onTouchEnd, true);
      ownerDocument.removeEventListener("touchcancel", onTouchEnd, true);
      ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
      ownerWindow.removeEventListener("blur", interruptTouch);
      ownerWindow.removeEventListener("focus", onPageShow);
      ownerWindow.removeEventListener("pagehide", interruptTouch);
      ownerWindow.removeEventListener("pageshow", onPageShow);
    };
  }, [containerEl, restoreToolbarAfterContainerScroll]);

  const handlePtyLongPressEnd = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      longPressCandidateRef.current = null;
      longPressFixedEndpointRef.current = null;
      showToolbarForCurrentSelection({ clientX, clientY });
    },
    [showToolbarForCurrentSelection],
  );

  const copyPtySelection = useCallback((): void => {
    const selected = refreshCurrentSelection()?.text ?? "";
    if (!selected) return;

    void copyText(selected, { allowLegacyFallback: true }).then((result) => {
      clearPtySelection();
      if (result === "failed") toast.error("复制失败");
      else toast.success("已复制");
    });
  }, [clearPtySelection, refreshCurrentSelection]);

  const openPtySelectionPathAction = useCallback((): void => {
    if (!refreshCurrentSelection()) return;
    const action = selectedPathActionRef.current;
    if (!action) return;
    if (action.kind === "image-preview") onPreviewPath(action.path);
    else onDownloadPath(action.path);
    clearPtySelection();
  }, [clearPtySelection, onDownloadPath, onPreviewPath, refreshCurrentSelection]);

  const isSelectionActive = useCallback(
    (): boolean => getPtyManagedSelectionRange(managedStateRef.current) !== null,
    [],
  );

  const getPtyTouchScrollPosition = useCallback(() => {
    if (!containerEl || performance.now() <= selectionViewportTransitionUntilRef.current) {
      return null;
    }
    return { scrollLeft: containerEl.scrollLeft, scrollTop: containerEl.scrollTop };
  }, [containerEl]);

  const handlePtySelectionHandleDragStart = useCallback(
    (kind: PtySelectionHandleKind): void => {
      activeHandleDragKindRef.current = kind;
      const range = getPtyManagedSelectionRange(managedStateRef.current);
      handleDragRestoreRef.current = range
        ? {
            range: {
              ...range,
              anchor: { ...range.anchor },
              focus: { ...range.focus },
            },
            lines: new Map(selectionLinesRef.current),
          }
        : null;
      setToolbarPresentation("hide");
      setPtySelectionToolbar(null);
    },
    [setToolbarPresentation],
  );

  const handlePtySelectionHandleDragMove = useCallback(
    (kind: PtySelectionHandleKind, { clientX, clientY }: { clientX: number; clientY: number }) => {
      const point = getPointAtClient(clientX, clientY, true);
      const current = getPtyManagedSelectionRange(managedStateRef.current);
      if (!point || !current) return;
      const selected: TerminalSelectionResult = {
        anchor: kind === "anchor" ? point : toTerminalPoint(current.anchor),
        focus: kind === "focus" ? point : toTerminalPoint(current.focus),
        columnMode: current.columnMode,
        text: "",
      };
      setManagedSelection(selected, {
        handles: true,
        toolbar: "hide",
        clientPoint: { clientX, clientY },
      });
    },
    [getPointAtClient, setManagedSelection],
  );

  const handlePtySelectionHandleDragEnd = useCallback(
    (_kind: PtySelectionHandleKind, point: { clientX: number; clientY: number } | null): void => {
      activeHandleDragKindRef.current = null;
      handleDragRestoreRef.current = null;
      showToolbarForCurrentSelection(point ?? undefined);
    },
    [showToolbarForCurrentSelection],
  );

  const handlePtySelectionHandleDragCancel = useCallback((): void => {
    activeHandleDragKindRef.current = null;
    const restore = handleDragRestoreRef.current;
    handleDragRestoreRef.current = null;
    if (!restore) {
      showToolbarForCurrentSelection();
      return;
    }
    selectionLinesRef.current = restore.lines;
    managedStateRef.current = reducePtyManagedSelection(managedStateRef.current, {
      type: "set-selection",
      range: restore.range,
    });
    if (!presentRange(restore.range, { handles: true, toolbar: "show" })) {
      clearPtySelection();
      return;
    }
    if (!bindCommittedSelectionMarkers(restore.range)) clearPtySelection();
  }, [
    bindCommittedSelectionMarkers,
    clearPtySelection,
    presentRange,
    showToolbarForCurrentSelection,
  ]);

  const selectionGesture = usePtySelectionGestureDriver({
    terminalRef,
    containerEl,
    suppressPtyFocus,
    focusPtyInput,
    isSelectionActive,
    isGestureTarget: ({ clientX, clientY }) => getPointAtClient(clientX, clientY, false) !== null,
    onTap,
    isTapCandidate,
    onLongPressCandidateStart: capturePtyLongPressCandidate,
    onLongPressStart: handlePtyLongPressStart,
    onLongPressMove: handlePtyLongPressMove,
    onLongPressEnd: handlePtyLongPressEnd,
    getTouchScrollPosition: getPtyTouchScrollPosition,
    onGestureFinish: (kind) => {
      if (shouldDismissManagedPtySelectionAfterGesture(kind)) clearPtySelection();
    },
    onVerticalScrollIntent: (reason) =>
      scrollControllerRef.current?.markSelectionAutoscrollIntent(reason),
    onHorizontalScrollIntent: (reason) =>
      scrollControllerRef.current?.markHorizontalScrollIntent(reason),
    onHandleDragStart: handlePtySelectionHandleDragStart,
    onHandleDragMove: handlePtySelectionHandleDragMove,
    onHandleDragEnd: handlePtySelectionHandleDragEnd,
    onHandleDragCancel: handlePtySelectionHandleDragCancel,
  });
  stopPtySelectionGestureRef.current = selectionGesture.stopPtySelectionGesture;

  return {
    pointerHandlers: selectionGesture.pointerHandlers,
    ptySelectionToolbar,
    ptySelectionHandles,
    ptySelectionPathAction,
    ptySelectionHandleMetrics,
    hasPtySelection: isSelectionActive,
    clearManagedPtySelection,
    clearPtySelection,
    copyPtySelection,
    openPtySelectionPathAction,
    handlePtySelectionHandlePointerDown: selectionGesture.handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart: selectionGesture.handlePtySelectionHandleTouchStart,
  };
}
