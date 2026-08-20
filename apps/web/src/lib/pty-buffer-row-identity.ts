import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

export interface PtyBufferRowIdentityTracker {
  getOffset: () => number;
  dispose: () => void;
}

/**
 * Tracks how many rows have been removed from the start of xterm's normal buffer.
 *
 * `viewportY` cannot provide this identity at the top of scrollback because it is clamped at zero.
 * A marker on the last normal-buffer row survives a single leading trim, and xterm emits `onScroll`
 * synchronously for every normal full-screen scroll. We checkpoint and replace that marker on each
 * such event, so it never ages into the trimmed row.
 *
 * Marker disposal is deliberately not interpreted as a trim. xterm sets `marker.line` to `-1`
 * before `onDispose`, and the same disposal path is used by CSI 2J, `Terminal.clear()`, reset, and
 * explicit marker disposal. Structural checkpoints only accept a negative marker delta when the
 * normal buffer's `length` and `baseY` decreased by that exact amount (for example CSI 3J).
 */
export function attachPtyBufferRowIdentityTracker(terminal: Terminal): PtyBufferRowIdentityTracker {
  let disposed = false;
  let committedOffset = 0;
  let marker: IMarker | null = null;
  let markerInitialLine = 0;
  let markerInitialLength = 0;
  let markerInitialBaseY = 0;
  let markerDisposeSubscription: IDisposable | null = null;

  const releaseMarker = (): void => {
    markerDisposeSubscription?.dispose();
    markerDisposeSubscription = null;
    const current = marker;
    marker = null;
    current?.dispose();
  };

  const registerNormalTailMarker = (): void => {
    if (disposed || marker || terminal.buffer.active.type !== "normal") return;

    const buffer = terminal.buffer.normal;
    const lastRow = buffer.length - 1;
    if (lastRow < 0) return;

    const cursorRow = buffer.baseY + buffer.cursorY;
    const next = terminal.registerMarker(lastRow - cursorRow);
    if (!next || next.isDisposed || next.line < 0) {
      next?.dispose();
      return;
    }

    marker = next;
    markerInitialLine = next.line;
    markerInitialLength = buffer.length;
    markerInitialBaseY = buffer.baseY;
    markerDisposeSubscription = next.onDispose(() => {
      if (disposed || marker !== next) return;
      // There is no public disposal reason, and `next.line` is already -1 here. Treat the anchor as
      // invalid and wait for the next checkpoint/getOffset to replace it without changing identity.
      markerDisposeSubscription = null;
      marker = null;
    });
  };

  const reanchorNormalTail = (): void => {
    releaseMarker();
    registerNormalTailMarker();
  };

  const commitScrollTrim = (): void => {
    if (terminal.buffer.active.type !== "normal") return;

    if (marker && !marker.isDisposed) {
      const delta = marker.line - markerInitialLine;
      if (delta < 0) committedOffset += delta;
    }
    reanchorNormalTail();
  };

  const commitProvenStructuralTrim = (): void => {
    if (terminal.buffer.active.type !== "normal") return;

    if (!marker || marker.isDisposed) {
      reanchorNormalTail();
      return;
    }

    const buffer = terminal.buffer.normal;
    const markerDelta = marker.line - markerInitialLine;
    const lengthDelta = buffer.length - markerInitialLength;
    const baseYDelta = buffer.baseY - markerInitialBaseY;
    if (markerDelta === 0 && lengthDelta === 0 && baseYDelta === 0) return;

    if (markerDelta < 0 && markerDelta === lengthDelta && markerDelta === baseYDelta) {
      committedOffset += markerDelta;
    }
    reanchorNormalTail();
  };

  registerNormalTailMarker();

  const subscriptions: IDisposable[] = [
    terminal.onScroll(commitScrollTrim),
    terminal.onWriteParsed(commitProvenStructuralTrim),
    // Reflow can insert/delete rows throughout the buffer, so it cannot be represented by this
    // leading-row scalar. Start a fresh baseline instead of reporting reflow as a trim.
    terminal.onResize(reanchorNormalTail),
    terminal.buffer.onBufferChange((buffer) => {
      if (buffer.type === "normal") reanchorNormalTail();
    }),
  ];

  return {
    getOffset: () => {
      commitProvenStructuralTrim();
      return committedOffset;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      releaseMarker();
    },
  };
}
