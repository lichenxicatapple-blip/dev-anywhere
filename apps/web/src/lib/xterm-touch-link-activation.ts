import type { IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { measureXtermCellSize } from "./pty-xterm-metrics";

export interface XtermLinkActivationPoint {
  clientX: number;
  clientY: number;
  pointerType?: "mouse" | "touch" | "pen";
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * A desktop link press captured before xterm's mousedown listeners run.
 *
 * `activateOnMouseUp` is intentionally one-shot and accepts the browser's original mouseup event,
 * so link providers receive the same trusted event and modifier state that xterm would pass them.
 */
export interface XtermDesktopLinkCandidate {
  readonly text: string;
  readonly range: IBufferRange;
  activateOnMouseUp: (event: MouseEvent) => boolean;
}

interface Xterm6LinkWithState {
  readonly link: ILink;
  readonly state?: { readonly isHovered?: boolean };
}

interface Xterm6Linkifier {
  readonly currentLink?: Xterm6LinkWithState;
}

interface Xterm6MouseService {
  getCoords: (
    event: Pick<MouseEvent, "clientX" | "clientY">,
    element: HTMLElement,
    colCount: number,
    rowCount: number,
  ) => [number, number] | undefined;
}

interface Xterm6CoreInternals {
  readonly linkifier?: Xterm6Linkifier;
  readonly screenElement?: HTMLElement;
  readonly _mouseService?: Xterm6MouseService;
}

interface Xterm6TerminalInternals {
  readonly _core?: Xterm6CoreInternals;
}

declare global {
  interface Window {
    __ccTestPtyTouchLinkActivations?: unknown[];
  }
}

function recordTouchLinkDebug(event: string, details: Record<string, unknown> = {}): void {
  const events = window.__ccTestPtyTouchLinkActivations;
  if (!events) return;
  events.push({ event, t: performance.now(), ...details });
  if (events.length > 200) events.splice(0, events.length - 200);
}

function linkContainsPosition(link: ILink, position: { x: number; y: number }, cols: number) {
  const lower = link.range.start.y * cols + link.range.start.x;
  const upper = link.range.end.y * cols + link.range.end.x;
  const current = position.y * cols + position.x;
  return lower <= current && current <= upper;
}

function linksEqual(a: ILink, b: ILink): boolean {
  return (
    a.text === b.text &&
    a.range.start.x === b.range.start.x &&
    a.range.start.y === b.range.start.y &&
    a.range.end.x === b.range.end.x &&
    a.range.end.y === b.range.end.y
  );
}

function getXterm6Core(terminal: Terminal): Xterm6CoreInternals | null {
  // @xterm/xterm 6.0.0 exposes Linkifier2 only through the public Terminal wrapper's `_core`.
  // Keep that pinned-version private boundary isolated here and fail closed if its shape changes.
  const core = (terminal as unknown as Xterm6TerminalInternals)._core;
  if (!core || typeof core !== "object") return null;
  return core;
}

function eventTargetsScreen(event: MouseEvent, screen: HTMLElement): boolean {
  return event.composedPath().includes(screen);
}

function getLinkifierPosition(
  terminal: Terminal,
  core: Xterm6CoreInternals,
  event: MouseEvent,
): { x: number; y: number } | null {
  const screen = core.screenElement;
  const mouseService = core._mouseService;
  if (!screen || !mouseService || !eventTargetsScreen(event, screen)) return null;

  let coords: [number, number] | undefined;
  try {
    coords = mouseService.getCoords(event, screen, terminal.cols, terminal.rows);
  } catch {
    return null;
  }
  if (!coords) return null;
  return { x: coords[0], y: coords[1] + terminal.buffer.active.viewportY };
}

function getHoveredXterm6Link(core: Xterm6CoreInternals): ILink | null {
  const current = core.linkifier?.currentLink;
  return current?.state?.isHovered === true ? current.link : null;
}

/**
 * Captures xterm 6's currently hovered Linkifier2 link during a primary-button mousedown.
 *
 * This only reads Linkifier2 state; it never dispatches or forwards the mousedown, so callers can
 * stop the original event in capture phase before SelectionService starts its private drag timer.
 * The returned candidate mirrors Linkifier2's release checks: the same logical link must still be
 * hovered and the real mouseup must land inside its range.
 */
export function captureXtermDesktopLinkCandidate(
  terminal: Terminal,
  mouseDownEvent: MouseEvent,
): XtermDesktopLinkCandidate | null {
  if (mouseDownEvent.type !== "mousedown" || mouseDownEvent.button !== 0) return null;
  const core = getXterm6Core(terminal);
  if (!core) return null;
  const pressedLink = getHoveredXterm6Link(core);
  const pressedPosition = getLinkifierPosition(terminal, core, mouseDownEvent);
  if (!pressedLink || !pressedPosition) return null;
  if (!linkContainsPosition(pressedLink, pressedPosition, terminal.cols)) return null;

  let finished = false;
  return {
    text: pressedLink.text,
    range: {
      start: { ...pressedLink.range.start },
      end: { ...pressedLink.range.end },
    },
    activateOnMouseUp: (mouseUpEvent) => {
      if (finished) return false;
      finished = true;
      if (mouseUpEvent.type !== "mouseup" || mouseUpEvent.button !== 0) return false;

      const currentCore = getXterm6Core(terminal);
      if (!currentCore) return false;
      const currentLink = getHoveredXterm6Link(currentCore);
      const releasePosition = getLinkifierPosition(terminal, currentCore, mouseUpEvent);
      if (
        !currentLink ||
        !releasePosition ||
        !linksEqual(pressedLink, currentLink) ||
        !linkContainsPosition(currentLink, releasePosition, terminal.cols)
      ) {
        return false;
      }

      currentLink.activate(mouseUpEvent, currentLink.text);
      return true;
    },
  };
}

function createLinkActivationEvent(point: XtermLinkActivationPoint): MouseEvent {
  const event = new MouseEvent("mouseup", {
    bubbles: true,
    cancelable: true,
    clientX: point.clientX,
    clientY: point.clientY,
    altKey: point.altKey,
    ctrlKey: point.ctrlKey,
    metaKey: point.metaKey,
    shiftKey: point.shiftKey,
  });
  Object.defineProperty(event, "pointerType", {
    configurable: true,
    value: point.pointerType ?? "touch",
  });
  return event;
}

function findXtermLinkAtPoint(
  terminal: Terminal,
  providers: readonly ILinkProvider[],
  point: XtermLinkActivationPoint,
): ILink | null {
  if (providers.length === 0) {
    recordTouchLinkDebug("skip", { reason: "no-providers", point });
    return null;
  }
  const terminalElement = terminal.element;
  const screen = terminalElement?.querySelector<HTMLElement>(".xterm-screen");
  const metricHost = terminalElement?.parentElement ?? terminalElement;
  if (!screen || !metricHost) {
    recordTouchLinkDebug("skip", {
      reason: "missing-elements",
      hasScreen: Boolean(screen),
      hasMetricHost: Boolean(metricHost),
      point,
    });
    return null;
  }

  const metrics = measureXtermCellSize(metricHost, terminal);
  if (!metrics || metrics.cellW <= 0 || metrics.cellH <= 0) {
    recordTouchLinkDebug("skip", { reason: "missing-metrics", metrics, point });
    return null;
  }

  const rect = screen.getBoundingClientRect();
  const viewportX = Math.floor((point.clientX - rect.left) / metrics.cellW) + 1;
  const viewportY = Math.floor((point.clientY - rect.top) / metrics.cellH) + 1;
  if (viewportX < 1 || viewportX > terminal.cols || viewportY < 1 || viewportY > terminal.rows) {
    recordTouchLinkDebug("skip", {
      reason: "point-out-of-range",
      point,
      viewportX,
      viewportY,
      cols: terminal.cols,
      rows: terminal.rows,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      metrics,
    });
    return null;
  }

  const bufferLineNumber = terminal.buffer.active.viewportY + viewportY;
  const position = { x: viewportX, y: bufferLineNumber };
  recordTouchLinkDebug("probe", {
    point,
    viewportX,
    viewportY,
    bufferLineNumber,
    providers: providers.length,
    metrics,
  });

  for (const provider of providers) {
    let matched: ILink | null = null;
    provider.provideLinks(bufferLineNumber, (links) => {
      recordTouchLinkDebug("links", {
        bufferLineNumber,
        position,
        count: links?.length ?? 0,
        links: links?.map((link) => ({
          text: link.text,
          range: link.range,
        })),
      });
      const link = links?.find((candidate) =>
        linkContainsPosition(candidate, position, terminal.cols),
      );
      if (!link) return;
      matched = link;
    });
    if (matched) return matched;
  }

  recordTouchLinkDebug("miss", { position, point, bufferLineNumber });
  return null;
}

export function hasXtermLinkAtPoint(
  terminal: Terminal,
  providers: readonly ILinkProvider[],
  point: XtermLinkActivationPoint,
): boolean {
  return findXtermLinkAtPoint(terminal, providers, point) !== null;
}

export function activateXtermLinkAtPoint(
  terminal: Terminal,
  providers: readonly ILinkProvider[],
  point: XtermLinkActivationPoint,
): boolean {
  const link = findXtermLinkAtPoint(terminal, providers, point);
  if (!link) return false;
  link.activate(createLinkActivationEvent(point), link.text);
  recordTouchLinkDebug("activate", {
    text: link.text,
    range: link.range,
    point,
  });
  return true;
}
