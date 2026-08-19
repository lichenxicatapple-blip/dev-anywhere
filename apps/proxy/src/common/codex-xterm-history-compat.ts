const SYNC_OUTPUT_START = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
const MAX_SYNC_BLOCK_CHARS = 1024 * 1024;
const ALT_SCREEN_SEQUENCE_RE = /\x1b\[\?(?:47|1047|1049)([hl])/g;
const HISTORY_INSERT_RE = /\x1b\[1;([1-9]\d*)r\x1b\[(\d*)S\x1b\[r\x1b\[([1-9]\d*);1H\x1b\[J/g;

export const CODEX_XTERM_HISTORY_COMPAT_ENV = "DEV_ANYWHERE_CODEX_XTERM_HISTORY_COMPAT";

type StreamState = "outside" | "buffering-sync" | "passthrough-sync";

export interface CodexXtermHistoryCompatStats {
  rewrittenTransactions: number;
  preservedRows: number;
}

/**
 * Rewrites Codex inline-history inserts into a full-screen scroll that xterm.js records in
 * scrollback. The matcher deliberately requires Codex's synchronized-output transaction and
 * immediate composer repaint; all other bytes pass through unchanged.
 *
 * Upstream context: https://github.com/openai/codex/issues/27644
 */
export class CodexXtermHistoryCompat {
  private pending = "";
  private state: StreamState = "outside";
  private alternateScreen = false;
  private altScanCarry = "";
  private terminalRows: number;
  private rewrittenTransactions = 0;
  private preservedRows = 0;

  constructor(rows: number) {
    this.terminalRows = rows;
  }

  get stats(): CodexXtermHistoryCompatStats {
    return {
      rewrittenTransactions: this.rewrittenTransactions,
      preservedRows: this.preservedRows,
    };
  }

  push(data: string): string {
    if (!data) return "";
    this.pending += data;
    let output = "";

    while (this.pending.length > 0) {
      if (this.state === "buffering-sync") {
        const endIndex = this.pending.indexOf(SYNC_OUTPUT_END, SYNC_OUTPUT_START.length);
        if (endIndex === -1) {
          if (this.pending.length <= MAX_SYNC_BLOCK_CHARS) break;
          const keep = longestSuffixPrefix(this.pending, SYNC_OUTPUT_END);
          const passthrough = this.pending.slice(0, this.pending.length - keep);
          output += passthrough;
          this.scanAlternateScreen(passthrough);
          this.pending = this.pending.slice(this.pending.length - keep);
          this.state = "passthrough-sync";
          continue;
        }

        const blockEnd = endIndex + SYNC_OUTPUT_END.length;
        const block = this.pending.slice(0, blockEnd);
        this.pending = this.pending.slice(blockEnd);
        output += this.rewriteSynchronizedBlock(block);
        this.state = "outside";
        continue;
      }

      if (this.state === "passthrough-sync") {
        const endIndex = this.pending.indexOf(SYNC_OUTPUT_END);
        if (endIndex === -1) {
          const keep = longestSuffixPrefix(this.pending, SYNC_OUTPUT_END);
          const passthrough = this.pending.slice(0, this.pending.length - keep);
          output += passthrough;
          this.scanAlternateScreen(passthrough);
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }

        const blockEnd = endIndex + SYNC_OUTPUT_END.length;
        const passthrough = this.pending.slice(0, blockEnd);
        output += passthrough;
        this.scanAlternateScreen(passthrough);
        this.pending = this.pending.slice(blockEnd);
        this.state = "outside";
        continue;
      }

      const startIndex = this.pending.indexOf(SYNC_OUTPUT_START);
      if (startIndex !== -1) {
        const passthrough = this.pending.slice(0, startIndex);
        output += passthrough;
        this.scanAlternateScreen(passthrough);
        this.pending = this.pending.slice(startIndex);
        this.state = "buffering-sync";
        continue;
      }

      const keep = longestSuffixPrefix(this.pending, SYNC_OUTPUT_START);
      const passthrough = this.pending.slice(0, this.pending.length - keep);
      output += passthrough;
      this.scanAlternateScreen(passthrough);
      this.pending = this.pending.slice(this.pending.length - keep);
      break;
    }

    return output;
  }

  /** Flushes an incomplete candidate byte-for-byte, for resize/exit boundaries. */
  flush(): string {
    const pending = this.pending;
    this.pending = "";
    this.state = "outside";
    this.scanAlternateScreen(pending);
    return pending;
  }

  setTerminalRows(rows: number): void {
    this.terminalRows = rows;
  }

  private rewriteSynchronizedBlock(block: string): string {
    const startsInAlternateScreen = this.alternateScreen;
    ALT_SCREEN_SEQUENCE_RE.lastIndex = 0;
    const switchesScreenBuffer = ALT_SCREEN_SEQUENCE_RE.test(block);
    ALT_SCREEN_SEQUENCE_RE.lastIndex = 0;

    let rewritten = block;
    if (!startsInAlternateScreen && !switchesScreenBuffer) {
      rewritten = block.replace(
        HISTORY_INSERT_RE,
        (original, bottomRaw: string, countRaw: string, repaintRowRaw: string) => {
          const bottom = Number.parseInt(bottomRaw, 10);
          const parsedCount = countRaw === "" ? 1 : Number.parseInt(countRaw, 10);
          const count = parsedCount === 0 ? 1 : parsedCount;
          const repaintRow = Number.parseInt(repaintRowRaw, 10);
          const expectedRepaintRow = bottom - count + 1;

          if (
            !Number.isSafeInteger(bottom) ||
            !Number.isSafeInteger(count) ||
            !Number.isSafeInteger(repaintRow) ||
            bottom >= this.terminalRows ||
            count < 1 ||
            count > bottom ||
            repaintRow !== expectedRepaintRow
          ) {
            return original;
          }

          this.rewrittenTransactions += 1;
          this.preservedRows += count;
          return `\x1b[r\x1b[999;1H${"\n".repeat(count)}\x1b[H\x1b[${repaintRow};1H\x1b[J`;
        },
      );
    }

    this.scanAlternateScreen(block);
    return rewritten;
  }

  private scanAlternateScreen(data: string): void {
    if (!data) return;
    const scan = this.altScanCarry + data;
    ALT_SCREEN_SEQUENCE_RE.lastIndex = 0;
    for (const match of scan.matchAll(ALT_SCREEN_SEQUENCE_RE)) {
      this.alternateScreen = match[1] === "h";
    }
    ALT_SCREEN_SEQUENCE_RE.lastIndex = 0;
    this.altScanCarry = scan.slice(-(SYNC_OUTPUT_START.length - 1));
  }
}

export function createCodexXtermHistoryCompat(
  provider: string | null | undefined,
  rows: number,
  env: NodeJS.ProcessEnv,
): CodexXtermHistoryCompat | null {
  if (provider !== "codex") return null;
  const configured = env[CODEX_XTERM_HISTORY_COMPAT_ENV]?.trim().toLowerCase();
  if (configured === "0" || configured === "false" || configured === "off") return null;
  return new CodexXtermHistoryCompat(rows);
}

function longestSuffixPrefix(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}
