import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { extractFileDownloadPaths } from "./file-download-path";
import { getMediaPreviewKind } from "./media-preview-path";
import { clearPathHoverSegments, createPathLinkHover } from "./xterm-path-link-hover";
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
  return findXtermPathMatchesInWrappedBuffer(
    terminal,
    bufferLineNumber,
    extractFileDownloadPaths,
    (path) => getMediaPreviewKind(path) === null,
  );
}

function shouldActivateDownload(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

export function registerFileDownloadLinkProvider(
  terminal: Pick<Terminal, "buffer" | "cols" | "element" | "registerLinkProvider" | "rows">,
  onDownload: (path: string, fallbackPath?: string) => void,
): { dispose: () => void; provider: ILinkProvider } {
  let lastActivation: { path: string; at: number } | null = null;

  const activateDownload = (
    { path, fallbackPath }: XtermBufferPathMatch,
    event: MouseEvent,
  ): void => {
    if (!shouldActivateDownload(event)) return;
    const now = performance.now();
    if (lastActivation?.path === path && now - lastActivation.at < DUPLICATE_ACTIVATION_WINDOW_MS) {
      return;
    }
    lastActivation = { path, at: now };
    if (fallbackPath) onDownload(path, fallbackPath);
    else onDownload(path);
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
            ...createPathLinkHover(terminal, match),
            // 桌面仍要求 cmd/ctrl + click 防误触。移动端下载走长按选区 toolbar,
            // tap 文件路径只用于命中/选区候选, 不直接拉取文件。
            activate: (event) => {
              activateDownload(match, event);
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
