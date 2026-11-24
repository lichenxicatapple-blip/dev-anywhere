import type { ILink, Terminal } from "@xterm/xterm";
import type { XtermBufferPathMatch } from "./xterm-wrapped-path-matches";

type PathHoverTerminal = Pick<Terminal, "buffer" | "cols" | "element" | "rows">;

export function createPathLinkHover(
  terminal: PathHoverTerminal,
  match: XtermBufferPathMatch,
): Pick<ILink, "decorations" | "hover" | "leave" | "dispose"> {
  let overlay: HTMLElement | undefined;
  const leave = () => {
    overlay?.remove();
    overlay = undefined;
  };
  return {
    decorations: { underline: false, pointerCursor: true },
    hover: () => {
      leave();
      overlay = renderPathHoverSegments(terminal, match);
    },
    leave,
    dispose: leave,
  };
}

function renderPathHoverSegments(
  terminal: PathHoverTerminal,
  match: XtermBufferPathMatch,
): HTMLElement | undefined {
  const element = terminal.element;
  if (!element) return;
  const screen = element.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || terminal.cols <= 0 || terminal.rows <= 0) return;
  const elementRect = element.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const cellW = (screen.clientWidth || screenRect.width) / terminal.cols;
  const cellH = (screen.clientHeight || screenRect.height) / terminal.rows;
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return;

  clearPathHoverSegments(terminal);
  ensureOverlayPositioning(element);

  const overlay = document.createElement("div");
  overlay.dataset.slot = "pty-file-link-hover-overlay";
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "4";
  element.append(overlay);

  const screenLeft = screenRect.left - elementRect.left;
  const screenTop = screenRect.top - elementRect.top;
  const viewportY = terminal.buffer.active.viewportY;

  for (const segment of match.segments) {
    const viewportRow = segment.lineNumber - viewportY;
    if (viewportRow < 1 || viewportRow > terminal.rows) continue;
    const underline = document.createElement("div");
    underline.dataset.slot = "pty-file-link-hover-segment";
    underline.dataset.range = `${segment.lineNumber}:${segment.startColumn}-${segment.endColumn}`;
    underline.style.position = "absolute";
    underline.style.left = `${screenLeft + (segment.startColumn - 1) * cellW}px`;
    underline.style.top = `${screenTop + (viewportRow - 1) * cellH + cellH - 2}px`;
    underline.style.width = `${Math.max(1, segment.endColumn - segment.startColumn + 1) * cellW}px`;
    underline.style.height = "2px";
    underline.style.background = "currentColor";
    underline.style.opacity = "0.8";
    overlay.append(underline);
  }
  return overlay;
}

export function clearPathHoverSegments(terminal: Pick<Terminal, "element">): void {
  terminal.element
    ?.querySelectorAll('[data-slot="pty-file-link-hover-overlay"]')
    .forEach((node) => node.remove());
}

function ensureOverlayPositioning(element: HTMLElement): void {
  const style = window.getComputedStyle(element);
  if (style.position !== "static") return;
  element.style.position = "relative";
}
