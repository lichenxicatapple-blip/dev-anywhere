import type { Terminal } from "@xterm/xterm";

interface Xterm6CursorInternals {
  readonly _core?: {
    readonly coreService?: { readonly isCursorHidden?: boolean };
  };
}

/**
 * A hidden terminal cursor is also the TUI's paint position. Software-cursor applications still
 * explicitly position it for input / IME, so keep following those positions, but not the column
 * reached by drawing a border or status row. Observe xterm's parser without consuming any bytes;
 * xterm remains responsible for parsing, cursor movement, and rendering.
 */
export function observePtyCursorFollowTarget(term: Terminal) {
  let positionedColumn: number | null = null;
  const column = (value: number) => Math.max(0, Math.min(term.cols - 1, value));
  const disposables = [
    ...["G", "`", "H", "f"].map((final) =>
      term.parser.registerCsiHandler({ final }, (params) => {
        const value = params[final === "H" || final === "f" ? 1 : 0];
        positionedColumn = column((typeof value === "number" && value > 0 ? value : 1) - 1);
        return false;
      }),
    ),
    ...["C", "D", "a"].map((final) =>
      term.parser.registerCsiHandler({ final }, (params) => {
        const value = params[0];
        const distance = typeof value === "number" && value > 0 ? value : 1;
        positionedColumn = column(
          column(term.buffer.active.cursorX) + (final === "D" ? -distance : distance),
        );
        return false;
      }),
    ),
  ];

  return {
    reset: (): void => {
      positionedColumn = null;
    },
    canFollow: (): boolean => {
      if (term.modes.synchronizedOutputMode) return false;
      // xterm 6.0.0 does not expose DEC cursor visibility in its public modes API. Read its
      // canonical flag here rather than maintaining a second mode state across reset/snapshot.
      // DOM visibility cannot substitute: inactiveStyle="none" hides even a real input cursor.
      const hidden = (term as unknown as Xterm6CursorInternals)._core?.coreService?.isCursorHidden;
      return hidden !== true || term.buffer.active.cursorX === positionedColumn;
    },
    dispose: (): void => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
