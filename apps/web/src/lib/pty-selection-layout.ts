import type { IBufferLine, Terminal } from "@xterm/xterm";
import {
  getClientPositionForTerminalPoint,
  type TerminalSelectionPoint,
} from "./pty-line-selection";
import { computePtySelectionToolbarPosition } from "./pty-selection-overlay-position";

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

interface GetPtySelectionHandlesOptions {
  terminal: Terminal;
  host: HTMLElement;
  coordinateSpace?: HTMLElement | null;
  anchor: TerminalSelectionPoint;
  focus: TerminalSelectionPoint;
  columnMode?: boolean;
  getLine?: (row: number) => IBufferLine | null | undefined;
}

interface ComputePtySelectionToolbarPositionForHandlesOptions {
  handles: PtySelectionHandles;
  viewportWidth: number;
  viewportHeight: number;
  viewportOffsetLeft?: number;
  viewportOffsetTop?: number;
}

export function computePtySelectionHandleMetrics(ptyFontSize: number): PtySelectionHandleMetrics {
  return {
    visualSize: Math.round(Math.min(12, Math.max(8, ptyFontSize * 0.55))),
    stemSize: Math.round(Math.min(11, Math.max(7, ptyFontSize * 0.5))),
    touchSize: 44,
  };
}

export function getPtySelectionHandles({
  terminal,
  host,
  coordinateSpace,
  anchor,
  focus,
  columnMode = false,
  getLine,
}: GetPtySelectionHandlesOptions): PtySelectionHandles | null {
  const anchorComesFirst = columnMode
    ? anchor.column <= focus.column
    : anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column);
  const anchorPosition = getClientPositionForTerminalPoint({
    terminal,
    host,
    point: anchor,
    affinity: anchorComesFirst ? "before" : "after",
    getLine,
  });
  const focusPosition = getClientPositionForTerminalPoint({
    terminal,
    host,
    point: focus,
    affinity: anchorComesFirst ? "after" : "before",
    getLine,
  });
  if (!anchorPosition || !focusPosition) return null;
  if (!coordinateSpace) return { anchor: anchorPosition, focus: focusPosition };

  const rect = coordinateSpace.getBoundingClientRect();
  const toLocalPosition = (position: PtySelectionHandlePosition): PtySelectionHandlePosition => ({
    left: position.left - rect.left,
    top: position.top - rect.top,
  });
  return {
    anchor: toLocalPosition(anchorPosition),
    focus: toLocalPosition(focusPosition),
  };
}

export function computePtySelectionToolbarPositionForHandles({
  handles,
  viewportWidth,
  viewportHeight,
  viewportOffsetLeft = 0,
  viewportOffsetTop = 0,
}: ComputePtySelectionToolbarPositionForHandlesOptions): { left: number; top: number } {
  return computePtySelectionToolbarPosition({
    clientX: (handles.anchor.left + handles.focus.left) / 2,
    clientY: Math.min(handles.anchor.top, handles.focus.top),
    viewportWidth,
    viewportHeight,
    viewportOffsetLeft,
    viewportOffsetTop,
  });
}
