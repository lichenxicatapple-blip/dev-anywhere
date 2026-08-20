/**
 * Pure state for a PTY selection whose coordinates belong to the absolute xterm buffer.
 *
 * Viewport movement is deliberately not selection movement. A real pointer move must first
 * establish selection ownership; only then may the selection's own autoscroll advance an
 * endpoint. Ambient wheel and scroll events are no-ops, and a press never clears an existing
 * range before its gesture is explicitly classified.
 */

export interface PtySelectionBufferPoint {
  readonly row: number;
  readonly column: number;
}

export interface PtySelectionRange {
  readonly anchor: PtySelectionBufferPoint;
  readonly focus: PtySelectionBufferPoint;
  readonly columnMode?: boolean;
}

export interface PtySelectionClientPoint {
  readonly x: number;
  readonly y: number;
}

export interface PtySelectionPointerPressCandidate {
  readonly pointerId: number;
  readonly client: PtySelectionClientPoint;
  readonly bufferPoint: PtySelectionBufferPoint | null;
  readonly columnMode?: boolean;
}

export type PtySelectionHandle = "anchor" | "focus";
export type PtyManagedSelectionPhase =
  | "idle"
  | "pressed"
  | "selecting"
  | "selected"
  | "handle-drag";

export type PtyManagedSelectionFinishResult =
  | "commit-selection"
  | "preserve-selection"
  | "clear-on-click";

interface PtyIdleSelectionState {
  readonly phase: "idle";
}

interface PtyPressedSelectionState {
  readonly phase: "pressed";
  readonly press: PtySelectionPointerPressCandidate;
  readonly selectionBeforePress: PtySelectionRange | null;
  readonly resolvedPressRange: PtySelectionRange | null;
}

interface PtySelectingSelectionState {
  readonly phase: "selecting";
  readonly pointerId: number;
  readonly pressClient: PtySelectionClientPoint;
  readonly lastClient: PtySelectionClientPoint;
  readonly selectionBeforePress: PtySelectionRange | null;
  readonly range: PtySelectionRange;
}

interface PtySelectedSelectionState {
  readonly phase: "selected";
  readonly range: PtySelectionRange;
}

interface PtyHandleDragSelectionState {
  readonly phase: "handle-drag";
  readonly pointerId: number;
  readonly handle: PtySelectionHandle;
  readonly pressClient: PtySelectionClientPoint;
  readonly lastClient: PtySelectionClientPoint;
  readonly hasRealMovement: boolean;
  readonly rangeBeforeDrag: PtySelectionRange;
  readonly range: PtySelectionRange;
}

export type PtyManagedSelectionState =
  | PtyIdleSelectionState
  | PtyPressedSelectionState
  | PtySelectingSelectionState
  | PtySelectedSelectionState
  | PtyHandleDragSelectionState;

export type PtyManagedSelectionEvent =
  | { readonly type: "pointer-press"; readonly candidate: PtySelectionPointerPressCandidate }
  | {
      readonly type: "resolve-press-range";
      readonly pointerId: number;
      readonly range: PtySelectionRange;
    }
  | {
      readonly type: "pointer-move";
      readonly pointerId: number;
      readonly client: PtySelectionClientPoint;
      readonly bufferPoint: PtySelectionBufferPoint | null;
      readonly range?: PtySelectionRange | null;
    }
  | {
      readonly type: "selection-autoscroll";
      readonly pointerId: number;
      readonly bufferPoint: PtySelectionBufferPoint | null;
      readonly range?: PtySelectionRange | null;
    }
  | {
      readonly type: "handle-drag-start";
      readonly pointerId: number;
      readonly handle: PtySelectionHandle;
      readonly client: PtySelectionClientPoint;
    }
  | {
      readonly type: "gesture-finish";
      readonly pointerId: number;
      readonly result: PtyManagedSelectionFinishResult;
    }
  | { readonly type: "viewport-scroll"; readonly source: "wheel" | "scroll" }
  | { readonly type: "set-selection"; readonly range: PtySelectionRange }
  | { readonly type: "clear-selection" };

const IDLE_SELECTION_STATE: PtyIdleSelectionState = { phase: "idle" };

export function createInitialPtyManagedSelectionState(): PtyManagedSelectionState {
  return IDLE_SELECTION_STATE;
}

export function getPtyManagedSelectionRange(
  state: PtyManagedSelectionState,
): PtySelectionRange | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "pressed":
      return state.resolvedPressRange ?? state.selectionBeforePress;
    case "selecting":
    case "selected":
    case "handle-drag":
      return state.range;
  }
}

export function canPtyManagedSelectionAutoscroll(state: PtyManagedSelectionState): boolean {
  return (
    (state.phase === "selecting" || (state.phase === "handle-drag" && state.hasRealMovement)) &&
    isValidBufferPoint(state.range.anchor)
  );
}

function isValidBufferPoint(
  point: PtySelectionBufferPoint | null,
): point is PtySelectionBufferPoint {
  return (
    point !== null &&
    Number.isInteger(point.row) &&
    point.row >= 0 &&
    Number.isInteger(point.column) &&
    point.column >= 0
  );
}

function isValidClientPoint(point: PtySelectionClientPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isValidRange(range: PtySelectionRange): boolean {
  return isValidBufferPoint(range.anchor) && isValidBufferPoint(range.focus);
}

function cloneBufferPoint(point: PtySelectionBufferPoint): PtySelectionBufferPoint {
  return { row: point.row, column: point.column };
}

function cloneClientPoint(point: PtySelectionClientPoint): PtySelectionClientPoint {
  return { x: point.x, y: point.y };
}

function cloneRange(range: PtySelectionRange): PtySelectionRange {
  return {
    anchor: cloneBufferPoint(range.anchor),
    focus: cloneBufferPoint(range.focus),
    columnMode: range.columnMode,
  };
}

export function rebasePtySelectionRangeRows(
  range: PtySelectionRange,
  delta: number,
): PtySelectionRange | null {
  if (!Number.isInteger(delta)) return null;
  const anchorRow = range.anchor.row + delta;
  const focusRow = range.focus.row + delta;
  if (anchorRow < 0 || focusRow < 0) return null;
  return {
    anchor: { ...range.anchor, row: anchorRow },
    focus: { ...range.focus, row: focusRow },
    columnMode: range.columnMode,
  };
}

function rebaseBufferPoint(
  point: PtySelectionBufferPoint | null,
  delta: number,
): PtySelectionBufferPoint | null {
  if (!point) return null;
  const row = point.row + delta;
  return row < 0 ? null : { ...point, row };
}

/** Rebase an in-flight gesture when xterm trims normal-buffer rows above it. */
export function rebasePtyManagedSelectionRows(
  state: PtyManagedSelectionState,
  delta: number,
): PtyManagedSelectionState {
  if (!Number.isInteger(delta) || delta === 0 || state.phase === "idle") return state;

  if (state.phase === "selected") {
    return selectedOrIdle(rebasePtySelectionRangeRows(state.range, delta));
  }

  if (state.phase === "pressed") {
    const pressPoint = rebaseBufferPoint(state.press.bufferPoint, delta);
    const selectionBeforePress = state.selectionBeforePress
      ? rebasePtySelectionRangeRows(state.selectionBeforePress, delta)
      : null;
    const resolvedPressRange = state.resolvedPressRange
      ? rebasePtySelectionRangeRows(state.resolvedPressRange, delta)
      : null;
    if (state.press.bufferPoint && !pressPoint) return selectedOrIdle(selectionBeforePress);
    return {
      ...state,
      press: { ...state.press, bufferPoint: pressPoint },
      selectionBeforePress,
      resolvedPressRange,
    };
  }

  if (state.phase === "selecting") {
    const selectionBeforePress = state.selectionBeforePress
      ? rebasePtySelectionRangeRows(state.selectionBeforePress, delta)
      : null;
    const range = rebasePtySelectionRangeRows(state.range, delta);
    return range ? { ...state, selectionBeforePress, range } : selectedOrIdle(selectionBeforePress);
  }

  const rangeBeforeDrag = rebasePtySelectionRangeRows(state.rangeBeforeDrag, delta);
  const range = rebasePtySelectionRangeRows(state.range, delta);
  return range && rangeBeforeDrag
    ? { ...state, rangeBeforeDrag, range }
    : selectedOrIdle(rangeBeforeDrag);
}

function clientPointChanged(a: PtySelectionClientPoint, b: PtySelectionClientPoint): boolean {
  return a.x !== b.x || a.y !== b.y;
}

function selectedOrIdle(range: PtySelectionRange | null): PtyManagedSelectionState {
  return range ? { phase: "selected", range: cloneRange(range) } : IDLE_SELECTION_STATE;
}

function updateDraggedEndpoint(
  range: PtySelectionRange,
  handle: PtySelectionHandle,
  point: PtySelectionBufferPoint,
): PtySelectionRange {
  // The anchor is immutable during ordinary selection. This is the only helper allowed to replace
  // it, and it is reachable only from an explicit anchor-handle drag state.
  return handle === "anchor"
    ? { anchor: cloneBufferPoint(point), focus: range.focus, columnMode: range.columnMode }
    : { anchor: range.anchor, focus: cloneBufferPoint(point), columnMode: range.columnMode };
}

function activePointerMatches(state: PtyManagedSelectionState, pointerId: number): boolean {
  switch (state.phase) {
    case "pressed":
      return state.press.pointerId === pointerId;
    case "selecting":
    case "handle-drag":
      return state.pointerId === pointerId;
    case "idle":
    case "selected":
      return false;
  }
}

function finishGesture(
  state: PtyManagedSelectionState,
  result: PtyManagedSelectionFinishResult,
): PtyManagedSelectionState {
  if (result === "clear-on-click") return IDLE_SELECTION_STATE;

  if (result === "preserve-selection") {
    switch (state.phase) {
      case "pressed":
      case "selecting":
        return selectedOrIdle(state.selectionBeforePress);
      case "handle-drag":
        return selectedOrIdle(state.rangeBeforeDrag);
      case "idle":
      case "selected":
        return state;
    }
  }

  switch (state.phase) {
    case "pressed":
      return selectedOrIdle(state.resolvedPressRange ?? state.selectionBeforePress);
    case "selecting":
    case "handle-drag":
      return selectedOrIdle(state.range);
    case "idle":
    case "selected":
      return state;
  }
}

export function reducePtyManagedSelection(
  state: PtyManagedSelectionState,
  event: PtyManagedSelectionEvent,
): PtyManagedSelectionState {
  switch (event.type) {
    case "pointer-press": {
      if (state.phase !== "idle" && state.phase !== "selected") return state;
      if (
        !Number.isFinite(event.candidate.pointerId) ||
        !isValidClientPoint(event.candidate.client)
      ) {
        return state;
      }
      const selectionBeforePress = state.phase === "selected" ? cloneRange(state.range) : null;
      return {
        phase: "pressed",
        press: {
          pointerId: event.candidate.pointerId,
          client: cloneClientPoint(event.candidate.client),
          bufferPoint: isValidBufferPoint(event.candidate.bufferPoint)
            ? cloneBufferPoint(event.candidate.bufferPoint)
            : null,
          columnMode: event.candidate.columnMode,
        },
        selectionBeforePress,
        resolvedPressRange: null,
      };
    }

    case "resolve-press-range": {
      if (
        state.phase !== "pressed" ||
        state.press.pointerId !== event.pointerId ||
        !state.press.bufferPoint ||
        !isValidRange(event.range)
      ) {
        return state;
      }
      return { ...state, resolvedPressRange: cloneRange(event.range) };
    }

    case "pointer-move": {
      if (!isValidClientPoint(event.client) || !activePointerMatches(state, event.pointerId)) {
        return state;
      }

      if (state.phase === "pressed") {
        if (!clientPointChanged(state.press.client, event.client)) return state;
        const anchor = state.resolvedPressRange?.anchor ?? state.press.bufferPoint;
        if (!isValidBufferPoint(anchor) || !isValidBufferPoint(event.bufferPoint)) return state;
        const movedRange =
          event.range && isValidRange(event.range) ? cloneRange(event.range) : null;
        return {
          phase: "selecting",
          pointerId: state.press.pointerId,
          pressClient: state.press.client,
          lastClient: cloneClientPoint(event.client),
          selectionBeforePress: state.selectionBeforePress,
          range: movedRange ?? {
            anchor: cloneBufferPoint(anchor),
            focus: cloneBufferPoint(event.bufferPoint),
            columnMode: state.resolvedPressRange?.columnMode ?? state.press.columnMode,
          },
        };
      }

      if (state.phase === "selecting") {
        if (!clientPointChanged(state.lastClient, event.client)) return state;
        return {
          ...state,
          lastClient: cloneClientPoint(event.client),
          range:
            event.range && isValidRange(event.range)
              ? cloneRange(event.range)
              : isValidBufferPoint(event.bufferPoint)
                ? {
                    anchor: state.range.anchor,
                    focus: cloneBufferPoint(event.bufferPoint),
                    columnMode: state.range.columnMode,
                  }
                : state.range,
        };
      }

      if (state.phase === "handle-drag") {
        if (!clientPointChanged(state.lastClient, event.client)) return state;
        const hasRealMovement =
          state.hasRealMovement || clientPointChanged(state.pressClient, event.client);
        return {
          ...state,
          lastClient: cloneClientPoint(event.client),
          hasRealMovement,
          range:
            hasRealMovement && isValidBufferPoint(event.bufferPoint)
              ? updateDraggedEndpoint(state.range, state.handle, event.bufferPoint)
              : state.range,
        };
      }

      return state;
    }

    case "selection-autoscroll": {
      if (
        !activePointerMatches(state, event.pointerId) ||
        !canPtyManagedSelectionAutoscroll(state) ||
        !isValidBufferPoint(event.bufferPoint)
      ) {
        return state;
      }
      if (state.phase === "selecting") {
        return {
          ...state,
          range:
            event.range && isValidRange(event.range)
              ? cloneRange(event.range)
              : {
                  anchor: state.range.anchor,
                  focus: cloneBufferPoint(event.bufferPoint),
                  columnMode: state.range.columnMode,
                },
        };
      }
      if (state.phase === "handle-drag") {
        return {
          ...state,
          range: updateDraggedEndpoint(state.range, state.handle, event.bufferPoint),
        };
      }
      return state;
    }

    case "handle-drag-start": {
      if (
        state.phase !== "selected" ||
        !Number.isFinite(event.pointerId) ||
        !isValidClientPoint(event.client)
      ) {
        return state;
      }
      const range = cloneRange(state.range);
      return {
        phase: "handle-drag",
        pointerId: event.pointerId,
        handle: event.handle,
        pressClient: cloneClientPoint(event.client),
        lastClient: cloneClientPoint(event.client),
        hasRealMovement: false,
        rangeBeforeDrag: range,
        range,
      };
    }

    case "gesture-finish": {
      if (!activePointerMatches(state, event.pointerId)) return state;
      return finishGesture(state, event.result);
    }

    case "viewport-scroll":
      // Scrolling changes only the projection from buffer coordinates to the viewport. The
      // absolute selection endpoints remain untouched, regardless of wheel/touch ownership.
      return state;

    case "set-selection":
      return isValidRange(event.range)
        ? { phase: "selected", range: cloneRange(event.range) }
        : state;

    case "clear-selection":
      return IDLE_SELECTION_STATE;
  }
}
