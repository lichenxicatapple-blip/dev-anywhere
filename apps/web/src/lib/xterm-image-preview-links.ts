import type { Terminal, ILink, ILinkProvider } from "@xterm/xterm";
import { extractImagePreviewPaths } from "./image-preview-path";

type ImagePreviewPathMatch = {
  path: string;
  startColumn: number;
  endColumn: number;
};

export function findImagePreviewPathMatches(line: string): ImagePreviewPathMatch[] {
  const paths = extractImagePreviewPaths(line);
  const matches: ImagePreviewPathMatch[] = [];
  let searchFrom = 0;
  for (const path of paths) {
    const rawIndex = line.indexOf(path, searchFrom);
    if (rawIndex < 0) continue;
    const atIndex = rawIndex > 0 && line[rawIndex - 1] === "@" ? rawIndex - 1 : rawIndex;
    const endIndex = rawIndex + path.length;
    matches.push({
      path,
      startColumn: stringToTerminalColumn(line, atIndex),
      endColumn: stringToTerminalColumn(line, endIndex) - 1,
    });
    searchFrom = rawIndex + path.length;
  }
  return matches;
}

function stringToTerminalColumn(line: string, endIndex: number): number {
  return stringCellWidth(line.slice(0, endIndex)) + 1;
}

function stringCellWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += codePointCellWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

function codePointCellWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningCodePoint(codePoint)) return 0;
  return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

export function registerImagePreviewLinkProvider(
  terminal: Pick<Terminal, "buffer" | "registerLinkProvider">,
  onPreview: (path: string) => void,
): { dispose: () => void; provider: ILinkProvider } {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true);
      if (!line) {
        callback(undefined);
        return;
      }
      const links: ILink[] = findImagePreviewPathMatches(line).map((match) => ({
        text: match.path,
        range: {
          start: { x: match.startColumn, y: bufferLineNumber },
          end: { x: match.endColumn, y: bufferLineNumber },
        },
        decorations: {
          underline: true,
          pointerCursor: true,
        },
        // PC: cmd/ctrl + click 防误触, 普通 click 只是阅读路径文本不触发.
        // 平板 / 手机触屏 (pointer: coarse) 没修饰键, tap 即触发; 平板接外置键盘
        // 走修饰键路径也照样 work.
        activate: (event) => {
          const isTouchSurface = window.matchMedia("(pointer: coarse), (hover: none)").matches;
          if (!isTouchSurface && !event.metaKey && !event.ctrlKey) return;
          onPreview(match.path);
        },
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
  const disposable = terminal.registerLinkProvider(provider);
  return { dispose: () => disposable.dispose(), provider };
}
