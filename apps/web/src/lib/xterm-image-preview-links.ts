import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { extractImagePreviewPaths } from "./image-preview-path";
import {
  findXtermPathMatches,
  findXtermPathMatchesInWrappedBuffer,
  getXtermPathLinkRanges,
  type XtermBufferPathMatch,
  type XtermPathMatch,
} from "./xterm-wrapped-path-matches";

export function findImagePreviewPathMatches(line: string): XtermPathMatch[] {
  return findXtermPathMatches(line, extractImagePreviewPaths);
}

export function findImagePreviewPathMatchesInWrappedBuffer(
  terminal: Pick<Terminal, "buffer">,
  bufferLineNumber: number,
): XtermBufferPathMatch[] {
  return findXtermPathMatchesInWrappedBuffer(terminal, bufferLineNumber, extractImagePreviewPaths);
}

function shouldActivatePreview(event: MouseEvent): boolean {
  if (event.metaKey || event.ctrlKey) return true;
  const pointerType =
    "pointerType" in event
      ? String((event as MouseEvent & { pointerType?: unknown }).pointerType)
      : "";
  if (pointerType === "touch" || pointerType === "pen") return true;
  return window.matchMedia?.("(pointer: coarse), (hover: none)")?.matches ?? false;
}

export function registerImagePreviewLinkProvider(
  terminal: Pick<Terminal, "buffer" | "registerLinkProvider">,
  onPreview: (path: string) => void,
): { dispose: () => void; provider: ILinkProvider } {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const matches = findImagePreviewPathMatchesInWrappedBuffer(terminal, bufferLineNumber);
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
              underline: true,
              pointerCursor: true,
            },
            // PC: cmd/ctrl + click 防误触, 普通 click 只是阅读路径文本不触发.
            // 平板 / 手机触屏 (pointer: coarse) 没修饰键, tap 即触发; 平板接外置键盘
            // 走修饰键路径也照样 work.
            activate: (event) => {
              if (!shouldActivatePreview(event)) return;
              onPreview(match.path);
            },
          });
        }
        return acc;
      }, []);
      callback(links.length > 0 ? links : undefined);
    },
  };
  const disposable = terminal.registerLinkProvider(provider);
  return { dispose: () => disposable.dispose(), provider };
}
