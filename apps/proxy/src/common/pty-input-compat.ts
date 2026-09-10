import type { ProviderId } from "../providers/types.js";

const WIN32_ESCAPE = "\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_";
// Six Win32 input fields fit in 68 characters, including uint32 control flags.
const INPUT_TAIL_LIMIT = 80;

/** Observe arbitrary local chunks; encode remote messages at complete key/paste boundaries. */
export function createPtyInputCompat(
  provider?: ProviderId,
  platform: NodeJS.Platform = process.platform,
) {
  let inputTail = "";
  let sawWin32Input = false;
  let inBracketedPaste = false;
  // eslint-disable-next-line no-control-regex
  const markers = /\x1b\[(?:200~|201~|(?:\d{0,10};){5}\d{0,10}_)/g;

  function observe(data: string): void {
    if (platform !== "win32") return;
    const input = inputTail + data;
    markers.lastIndex = 0;
    let consumed = 0;
    for (let match = markers.exec(input); match; match = markers.exec(input)) {
      if (match[0] === "\x1b[200~") {
        inBracketedPaste = true;
      } else if (match[0] === "\x1b[201~") {
        inBracketedPaste = false;
      } else if (!inBracketedPaste) {
        sawWin32Input = true;
      }
      consumed = markers.lastIndex;
    }
    inputTail = input.slice(consumed).slice(-INPUT_TAIL_LIMIT);
  }

  function encodeRemote(data: string): string {
    const wasInBracketedPaste = inBracketedPaste;
    observe(data);
    if (platform !== "win32" || wasInBracketedPaste) return data;
    // ConPTY maps LF to Ctrl+Enter, which Codex does not bind to insert-newline.
    // Alt+Enter is a supported, layout-independent key and keeps legacy VT input.
    if (provider === "codex" && data === "\n") return "\x1b\r";
    // After a native Win32 key, ConPTY buffers bare ESC as a sequence prefix.
    // Encode an actual Escape key only when that mode was already observed.
    if (sawWin32Input && data === "\x1b") return WIN32_ESCAPE;
    return data;
  }

  return { observe, encodeRemote };
}
