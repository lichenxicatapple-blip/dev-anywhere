import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { extractFileDownloadPaths } from "./file-download-path";
import {
  findXtermPathMatches,
  findXtermPathMatchesInWrappedBuffer,
  getXtermPathLinkRanges,
  type XtermBufferPathMatch,
  type XtermPathMatch,
} from "./xterm-wrapped-path-matches";

const DUPLICATE_ACTIVATION_WINDOW_MS = 750;

export function findFileDownloadPathMatches(line: string): XtermPathMatch[] {
  return findXtermPathMatches(line, extractFileDownloadPaths);
}

export function findFileDownloadPathMatchesInWrappedBuffer(
  terminal: Pick<Terminal, "buffer">,
  bufferLineNumber: number,
): XtermBufferPathMatch[] {
  return findXtermPathMatchesInWrappedBuffer(terminal, bufferLineNumber, extractFileDownloadPaths);
}

function shouldActivateDownload(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

export function registerFileDownloadLinkProvider(
  terminal: Pick<Terminal, "buffer" | "cols" | "element" | "registerLinkProvider" | "rows">,
  onDownload: (path: string) => void,
): { dispose: () => void; provider: ILinkProvider } {
  let lastActivation: { path: string; at: number } | null = null;

  const activateDownload = (path: string, event: MouseEvent): void => {
    if (!shouldActivateDownload(event)) return;
    const now = performance.now();
    if (lastActivation?.path === path && now - lastActivation.at < DUPLICATE_ACTIVATION_WINDOW_MS) {
      return;
    }
    lastActivation = { path, at: now };
    onDownload(path);
  };

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const matches = findFileDownloadPathMatchesInWrappedBuffer(terminal, bufferLineNumber);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const links = matches.reduce<ILink[]>((acc, match) => {
        for (const range of getXtermPathLinkRanges(match)) {
          if (range.start.y !== bufferLineNumber || range.end.y !== bufferLineNumber) continue;
          acc.push({
            text: match.path,
            range,
            decorations: {
              underline: false,
              pointerCursor: true,
            },
            hover: () => {
              renderPathHoverSegments(terminal, match);
            },
            leave: () => {
              clearPathHoverSegments(terminal);
            },
            dispose: () => {
              clearPathHoverSegments(terminal);
            },
            // 桌面仍要求 cmd/ctrl + click 防误触。移动端下载走长按选区 toolbar,
            // tap 文件路径只用于命中/选区候选, 不直接拉取文件。
            activate: (event) => {
              activateDownload(match.path, event);
            },
          });
        }
        return acc;
      }, []);
      callback(links.length > 0 ? links : undefined);
    },
  };
  const disposable = terminal.registerLinkProvider(provider);
  return {
    dispose: () => {
      clearPathHoverSegments(terminal);
      disposable.dispose();
    },
    provider,
  };
}

function renderPathHoverSegments(
  terminal: Pick<Terminal, "buffer" | "cols" | "element" | "rows">,
  match: XtermBufferPathMatch,
): void {
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
}

function clearPathHoverSegments(terminal: Pick<Terminal, "element">): void {
  terminal.element
    ?.querySelectorAll('[data-slot="pty-file-link-hover-overlay"]')
    .forEach((node) => node.remove());
}

function ensureOverlayPositioning(element: HTMLElement): void {
  const style = window.getComputedStyle(element);
  if (style.position !== "static") return;
  element.style.position = "relative";
}
