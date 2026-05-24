import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { measureXtermCellSize } from "./pty-xterm-metrics";

export interface XtermTouchLinkPoint {
  clientX: number;
  clientY: number;
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

function createTouchActivationEvent(point: XtermTouchLinkPoint): MouseEvent {
  const event = new MouseEvent("mouseup", {
    bubbles: true,
    cancelable: true,
    clientX: point.clientX,
    clientY: point.clientY,
  });
  Object.defineProperty(event, "pointerType", {
    configurable: true,
    value: "touch",
  });
  return event;
}

function findXtermLinkAtPoint(
  terminal: Terminal,
  providers: readonly ILinkProvider[],
  point: XtermTouchLinkPoint,
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
  point: XtermTouchLinkPoint,
): boolean {
  return findXtermLinkAtPoint(terminal, providers, point) !== null;
}

export function activateXtermLinkAtPoint(
  terminal: Terminal,
  providers: readonly ILinkProvider[],
  point: XtermTouchLinkPoint,
): boolean {
  const link = findXtermLinkAtPoint(terminal, providers, point);
  if (!link) return false;
  link.activate(createTouchActivationEvent(point), link.text);
  recordTouchLinkDebug("activate", {
    text: link.text,
    range: link.range,
    point,
  });
  return true;
}
