import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { measureXtermCellSize } from "./pty-xterm-metrics";

export interface XtermTouchLinkPoint {
  clientX: number;
  clientY: number;
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

export function activateXtermLinkAtPoint(
  terminal: Terminal,
  providers: readonly ILinkProvider[],
  point: XtermTouchLinkPoint,
): boolean {
  if (providers.length === 0) return false;
  const terminalElement = terminal.element;
  const screen = terminalElement?.querySelector<HTMLElement>(".xterm-screen");
  const metricHost = terminalElement?.parentElement ?? terminalElement;
  if (!screen || !metricHost) return false;

  const metrics = measureXtermCellSize(metricHost, terminal);
  if (!metrics || metrics.cellW <= 0 || metrics.cellH <= 0) return false;

  const rect = screen.getBoundingClientRect();
  const viewportX = Math.floor((point.clientX - rect.left) / metrics.cellW) + 1;
  const viewportY = Math.floor((point.clientY - rect.top) / metrics.cellH) + 1;
  if (viewportX < 1 || viewportX > terminal.cols || viewportY < 1 || viewportY > terminal.rows) {
    return false;
  }

  const bufferLineNumber = terminal.buffer.active.viewportY + viewportY;
  const position = { x: viewportX, y: bufferLineNumber };

  for (const provider of providers) {
    let activated = false;
    provider.provideLinks(bufferLineNumber, (links) => {
      const link = links?.find((candidate) =>
        linkContainsPosition(candidate, position, terminal.cols),
      );
      if (!link) return;
      link.activate(createTouchActivationEvent(point), link.text);
      activated = true;
    });
    if (activated) return true;
  }

  return false;
}
