import { describe, expect, it } from "vitest";
import {
  computeHostTop,
  computePtyHostLayout,
  computePtyLiveBackfill,
  computePtyLiveBottom,
  computePtyLiveViewportBridge,
  computeScrollAnchor,
  computeScrollTarget,
  ydispToScrollTop,
} from "./pty-scroll";

describe("PTY scroll geometry", () => {
  it("computes spacer and host dimensions from terminal metrics", () => {
    expect(
      computePtyHostLayout(
        {
          bufferLength: 120,
          baseY: 96,
          rows: 24,
          cols: 80,
          viewportY: 0,
          cellH: 20,
          cellW: 10,
        },
        23,
      ),
    ).toEqual({
      spacerHeight: 2400,
      spacerWidth: 800,
      hostWidth: 800,
      hostHeight: 480,
      hostPaddingTop: 0,
    });
  });

  it("adds cold-start bottom padding when visible rows are mostly blank", () => {
    expect(
      computePtyHostLayout(
        {
          bufferLength: 24,
          baseY: 0,
          rows: 24,
          cols: 80,
          viewportY: 0,
          cellH: 20,
          cellW: 10,
        },
        4,
      )?.hostPaddingTop,
    ).toBe(380);
  });

  it("extends scroll space when the terminal screen is shorter than the viewport", () => {
    expect(
      computePtyHostLayout(
        {
          bufferLength: 371,
          baseY: 323,
          rows: 48,
          cols: 212,
          viewportY: 270,
          cellH: 12,
          cellW: 6,
          visibleContentHeight: 1212,
        },
        47,
      )?.spacerHeight,
    ).toBe(5088);
  });

  it("keeps the sticky release range when the terminal screen is taller than the viewport", () => {
    expect(
      computePtyHostLayout(
        {
          bufferLength: 120,
          baseY: 80,
          rows: 40,
          cols: 80,
          viewportY: 0,
          cellH: 20,
          cellW: 10,
          visibleContentHeight: 500,
        },
        39,
      )?.spacerHeight,
    ).toBe(2400);
  });

  it("caps long-host spacer at the meaningful live tail when the cursor is near the top", () => {
    const metrics = {
      bufferLength: 209,
      baseY: 155,
      rows: 54,
      cols: 270,
      viewportY: 155,
      cellH: 20,
      cellW: 8,
      visibleContentHeight: 594,
      cursorY: 13,
    };

    expect(computePtyHostLayout(metrics, 13)?.spacerHeight).toBe(3380);
  });

  it("keeps enough long-host spacer to bottom-align a mid-screen live tail", () => {
    const metrics = {
      bufferLength: 905,
      baseY: 853,
      rows: 52,
      cols: 80,
      viewportY: 853,
      cellH: 20,
      cellW: 10,
      visibleContentHeight: 200,
      cursorY: 25,
    };

    expect(computePtyHostLayout(metrics, 25)?.spacerHeight).toBe(17580);
  });

  it("keeps one semantic anchor when keyboard close changes a host from long to short", () => {
    const metrics = {
      bufferLength: 124,
      baseY: 100,
      rows: 24,
      cols: 80,
      viewportY: 100,
      cursorY: 10,
      cellH: 20,
      cellW: 10,
    };
    const keyboardOpen = computePtyHostLayout({ ...metrics, visibleContentHeight: 260 }, 10);
    const keyboardClosed = computePtyHostLayout({ ...metrics, visibleContentHeight: 600 }, 10);

    expect(keyboardOpen!.spacerHeight - 260).toBe(1960);
    expect(keyboardClosed!.spacerHeight - 600).toBe(1740);
  });

  it("uses scrollback to fill the viewport below a mid-screen live prompt", () => {
    expect(
      computePtyLiveBottom({
        bufferLength: 221,
        baseY: 169,
        rows: 52,
        cursorY: 13,
        liveLastY: 13,
        cellH: 20,
        visibleContentHeight: 828,
      }),
    ).toEqual({ scrollTop: 2832, viewportY: 141, liveTailY: 13 });
  });

  it("keeps the cursor visible when a full-screen TUI tail cannot fit with it", () => {
    expect(
      computePtyLiveBottom({
        bufferLength: 905,
        baseY: 853,
        rows: 52,
        cursorY: 0,
        liveLastY: 51,
        cellH: 20,
        visibleContentHeight: 200,
      }),
    ).toEqual({ scrollTop: 17060, viewportY: 853, liveTailY: 51 });
  });

  it("keeps an exact viewport row with a repeating fractional cell height", () => {
    const cellH = 485 / 24;
    const liveBottom = computePtyLiveBottom({
      bufferLength: 254,
      baseY: 230,
      rows: 24,
      cursorY: 23,
      liveLastY: 23,
      cellH,
      visibleContentHeight: 697,
    });

    // Pixel-first arithmetic produces 229.99999999999997 here and loses the
    // cursor row. The row-space anchor must remain exactly 230.
    expect(liveBottom.scrollTop).toBe(230 * cellH);
    expect(liveBottom.viewportY).toBe(230);
    expect(liveBottom.liveTailY).toBe(23);
  });

  it("still floors a genuinely fractional viewport row", () => {
    const liveBottom = computePtyLiveBottom({
      bufferLength: 124,
      baseY: 100,
      rows: 24,
      cursorY: 10,
      liveLastY: 10,
      cellH: 20,
      visibleContentHeight: 244,
    });

    expect(liveBottom.scrollTop).toBe(1976);
    expect(liveBottom.viewportY).toBe(98);
  });

  it.each([
    { visibleContentHeight: 114, scrollTop: 115, viewportY: 7 },
    { visibleContentHeight: 115, scrollTop: 115, viewportY: 7 },
    { visibleContentHeight: 116, scrollTop: 114, viewportY: 6 },
  ])(
    "normalizes only floating-point noise at a partial-capacity row boundary ($visibleContentHeight px)",
    ({ visibleContentHeight, scrollTop, viewportY }) => {
      const liveBottom = computePtyLiveBottom({
        bufferLength: 21,
        baseY: 7,
        rows: 14,
        cursorY: 0,
        liveLastY: 6,
        cellH: 230 / 14,
        visibleContentHeight,
      });

      expect(liveBottom.scrollTop).toBeCloseTo(scrollTop, 8);
      expect(liveBottom.viewportY).toBe(viewportY);
    },
  );

  it("does not accumulate row error across a large scrollback base", () => {
    const liveBottom = computePtyLiveBottom({
      bufferLength: 5024,
      baseY: 5000,
      rows: 24,
      cursorY: 10,
      liveLastY: 10,
      cellH: 20,
      visibleContentHeight: 244,
    });

    expect(liveBottom.scrollTop).toBe(99_976);
    expect(liveBottom.viewportY).toBe(4998);
  });

  // 移动端窄高度: rows*cellH 远大于 visibleContentHeight, cold-start padding 若按 host 自身
  // 算出 (rows-1-canvasLastY)*cellH, 会把内容压到 host 内部远低于 visible 截断点的位置,
  // 整屏看不见。padding 的"底参考"必须夹到 min(host, visible)。
  it("caps cold-start padding at visibleContentHeight when host is taller than the visible area", () => {
    const layout = computePtyHostLayout(
      {
        bufferLength: 54,
        baseY: 0,
        rows: 54,
        cols: 80,
        viewportY: 0,
        cellH: 20,
        cellW: 27,
        visibleContentHeight: 729,
      },
      8,
    );
    expect(layout).not.toBeNull();
    expect(layout!.hostHeight).toBe(1080);
    // canvasLastY=8 → 9 行内容. padding + 9*cellH 必须落进 visible, 否则一行都看不到。
    expect(layout!.hostPaddingTop + 9 * 20).toBeLessThanOrEqual(729);
  });

  it("uses the cold-start cursor extent when the live-screen scan is empty", () => {
    const cursorY = 8;
    const layout = computePtyHostLayout(
      {
        bufferLength: 54,
        baseY: 0,
        rows: 54,
        cols: 80,
        viewportY: 0,
        cursorY,
        cellH: 20,
        cellW: 27,
        visibleContentHeight: 729,
      },
      -1,
    );

    expect(layout).not.toBeNull();
    expect(layout!.hostPaddingTop).toBe(549);
    // Even without a non-empty scanned line, the cursor row remains inside the visible area.
    expect(layout!.hostPaddingTop + (cursorY + 1) * 20).toBe(729);
  });

  it("treats an empty viewport as all but the last row blank", () => {
    expect(
      computePtyHostLayout(
        {
          bufferLength: 24,
          baseY: 0,
          rows: 24,
          cols: 80,
          viewportY: 0,
          cellH: 20,
          cellW: 10,
        },
        -1,
      )?.hostPaddingTop,
    ).toBe(460);
  });

  // 长会话光标在屏幕中段时, 光标下方的空行属于"光标余空"而非"冷启动留白"——
  // 此时 bufferLength 已远超 rows, viewport 上方都是有效 buffer 内容, 不应再加
  // hostPaddingTop, 否则把 host 内容向下推会在视窗顶部留出与 padding 等高的黑带。
  it("does not pad when buffer has scrolled past one screen, even if cursor is mid-screen", () => {
    expect(
      computePtyHostLayout(
        {
          bufferLength: 538,
          baseY: 486,
          rows: 52,
          cols: 270,
          viewportY: 486,
          cellH: 18,
          cellW: 8,
          visibleContentHeight: 871,
        },
        26,
      )?.hostPaddingTop,
    ).toBe(0);
  });

  it("maps scrollTop to a row-aligned ydisp", () => {
    expect(
      computeScrollTarget(45, {
        bufferLength: 100,
        rows: 20,
        cols: 80,
        viewportY: 0,
        cellH: 20,
        cellW: 10,
      }),
    ).toEqual({ ydisp: 2 });
  });

  it("clamps to max ydisp in the sticky-release range", () => {
    expect(
      computeScrollTarget(2000, {
        bufferLength: 100,
        rows: 20,
        cols: 80,
        viewportY: 0,
        cellH: 20,
        cellW: 10,
      }),
    ).toEqual({ ydisp: 80 });
  });

  describe("computeHostTop", () => {
    it("ydisp 0, host shorter than visible: pin to bottom of visible (verticalOffset)", () => {
      // host = 480, visible = 600 → verticalOffset = 120, ydisp 0 ⇒ top = 120
      expect(computeHostTop({ ydisp: 0, rows: 24, cellH: 20, visibleContentHeight: 600 })).toBe(
        120,
      );
    });

    it("ydisp > 0 inside scrollback: top = ydisp*cellH + verticalOffset", () => {
      // host 480 < visible 600, ydisp = 5, cellH = 20 ⇒ 100 + 120 = 220
      expect(computeHostTop({ ydisp: 5, rows: 24, cellH: 20, visibleContentHeight: 600 })).toBe(
        220,
      );
    });

    it("host taller than visible: verticalOffset = 0, top = ydisp*cellH", () => {
      // host 1080 > visible 729, ydisp = 8, cellH = 20 ⇒ 160
      expect(computeHostTop({ ydisp: 8, rows: 54, cellH: 20, visibleContentHeight: 729 })).toBe(
        160,
      );
    });

    it("visibleContentHeight undefined: verticalOffset = 0", () => {
      expect(computeHostTop({ ydisp: 5, rows: 24, cellH: 20 })).toBe(100);
    });

    it("cellH 0 returns 0 (degenerate measure path)", () => {
      expect(computeHostTop({ ydisp: 5, rows: 24, cellH: 0, visibleContentHeight: 600 })).toBe(0);
    });

    it("clamps to >= 0 when ydisp is negative", () => {
      expect(computeHostTop({ ydisp: -3, rows: 24, cellH: 20 })).toBe(0);
    });
  });

  describe("computePtyLiveBackfill", () => {
    it("fills the exact short-host gap with preceding scrollback rows", () => {
      expect(
        computePtyLiveBackfill({
          ydisp: 2010,
          rows: 25,
          cellH: 20,
          visibleContentHeight: 597,
        }),
      ).toEqual({
        startLine: 2005,
        endLine: 2009,
        rowCount: 5,
        rowHeight: 20,
        topOffset: -100,
      });
    });

    it("does not invent history for a fresh or full-height terminal", () => {
      expect(
        computePtyLiveBackfill({
          ydisp: 0,
          rows: 25,
          cellH: 20,
          visibleContentHeight: 597,
        }),
      ).toBeNull();
      expect(
        computePtyLiveBackfill({
          ydisp: 100,
          rows: 25,
          cellH: 20,
          visibleContentHeight: 480,
        }),
      ).toBeNull();
    });

    it("uses only available history when the buffer is still shallow", () => {
      expect(
        computePtyLiveBackfill({
          ydisp: 3,
          rows: 25,
          cellH: 20,
          visibleContentHeight: 597,
        }),
      ).toEqual({
        startLine: 0,
        endLine: 2,
        rowCount: 3,
        rowHeight: 20,
        topOffset: -60,
      });
    });

    it("fills the leading sliver exposed by a fractional full-height native scroll", () => {
      expect(
        computePtyLiveBackfill({
          ydisp: 80,
          rows: 20,
          cellH: 20,
          visibleContentHeight: 400,
          visibleTopLine: 79.7,
        }),
      ).toEqual({
        startLine: 79,
        endLine: 79,
        rowCount: 1,
        rowHeight: 20,
        topOffset: -20,
      });
    });

    it("adds the fractional overscan row on top of a short-host backfill", () => {
      expect(
        computePtyLiveBackfill({
          ydisp: 81,
          rows: 20,
          cellH: 20,
          visibleContentHeight: 600,
          visibleTopLine: 70.5,
        }),
      ).toEqual({
        startLine: 70,
        endLine: 80,
        rowCount: 11,
        rowHeight: 20,
        topOffset: -220,
      });
    });
  });

  describe("computePtyLiveViewportBridge", () => {
    it("covers the full fractional browser viewport relative to the last painted xterm row", () => {
      expect(
        computePtyLiveViewportBridge({
          ydisp: 80,
          rows: 20,
          cellH: 20,
          bufferLength: 120,
          visibleContentHeight: 400,
          visibleTopLine: 78.985,
        }),
      ).toEqual({
        startLine: 78,
        endLine: 98,
        rowCount: 21,
        rowHeight: 20,
        topOffset: -40,
      });
    });

    it("bridges both sides of a short host while a downward viewport paint is pending", () => {
      expect(
        computePtyLiveViewportBridge({
          ydisp: 86,
          rows: 24,
          cellH: 20,
          bufferLength: 200,
          visibleContentHeight: 760,
          visibleTopLine: 74.5,
        }),
      ).toEqual({
        startLine: 74,
        endLine: 112,
        rowCount: 39,
        rowHeight: 20,
        topOffset: -240,
      });
    });
  });

  describe("computeScrollAnchor", () => {
    const baseShortHost = {
      rows: 24,
      cellH: 20,
      bufferLength: 24,
      baseY: 0,
      viewportY: 0,
      cursorBufferRow: 0,
      liveLastY: 0,
      visibleContentHeight: 600,
      paddingTop: 8,
      paddingBottom: 0,
      hostPaddingTop: 0,
      containerScrollTop: 0,
      containerScrollHeight: 608,
      containerClientHeight: 608,
      atBottomThreshold: 8,
    } as const;

    it("short host uses the same semantic live-tail bottom", () => {
      const a = computeScrollAnchor(baseShortHost);
      expect(a.isAtBottom).toBe(true);
      expect(a.bottomScrollTop).toBe(0);
    });

    it("short host scrolled away from its semantic bottom stays in review", () => {
      const a = computeScrollAnchor({
        ...baseShortHost,
        containerScrollTop: 100,
        containerScrollHeight: 1200,
      });
      expect(a.isAtBottom).toBe(false);
      expect(a.bottomScrollTop).toBe(0);
    });

    const baseLongHost = {
      rows: 54,
      cellH: 20,
      bufferLength: 60,
      baseY: 6,
      viewportY: 0,
      cursorBufferRow: 8,
      liveLastY: 2,
      visibleContentHeight: 729,
      paddingTop: 8,
      paddingBottom: 0,
      hostPaddingTop: 0,
      containerScrollTop: 0,
      containerScrollHeight: 1200,
      containerClientHeight: 737,
      atBottomThreshold: 8,
    } as const;

    it("long host requires both semantic target alignment and cursor visibility", () => {
      // cursorBufferRow=8, cellH=20, paddingTop=8 → cursorPx = 8+160 = 168
      // viewportTop = 0+8 = 8, viewportBottom = 0+737-0 = 737
      // 168 ≥ 8 且 168+20 ≤ 737 ⇒ in viewport ⇒ at bottom
      const a = computeScrollAnchor(baseLongHost);
      expect(a.cursorInViewport).toBe(true);
      expect(a.isAtBottom).toBe(true);
    });

    it("long host: cursor scrolled out of viewport ⇒ not at bottom", () => {
      // 把容器往下滚 800: viewportTop=808, cursor 168 已经在视窗上方
      const a = computeScrollAnchor({ ...baseLongHost, containerScrollTop: 800 });
      expect(a.cursorInViewport).toBe(false);
      expect(a.isAtBottom).toBe(false);
    });

    it("long host: tolerates fractional cell height at cursor-aware bottom", () => {
      const a = computeScrollAnchor({
        rows: 54,
        cellH: 20.185185185185187,
        bufferLength: 262,
        baseY: 208,
        viewportY: 208,
        cursorBufferRow: 261,
        liveLastY: 53,
        visibleContentHeight: 697,
        paddingTop: 8,
        paddingBottom: 32,
        hostPaddingTop: 0,
        containerScrollTop: 4590.85693359375,
        containerScrollHeight: 5329,
        containerClientHeight: 737,
        atBottomThreshold: 8,
      });
      expect(a.bottomScrollTop).toBeCloseTo(4592, 0);
      expect(a.cursorInViewport).toBe(true);
      expect(a.isAtBottom).toBe(true);
    });

    it("long host: bottomScrollTop aligns the meaningful tail without blank rows", () => {
      const a = computeScrollAnchor(baseLongHost);
      expect(a.bottomScrollTop).toBe(0);
      expect(a.bottomViewportY).toBe(0);
    });

    it("keeps a semantic target beyond a temporarily stale DOM scroll maximum", () => {
      const a = computeScrollAnchor({
        rows: 52,
        cellH: 20,
        bufferLength: 905,
        baseY: 853,
        viewportY: 853,
        cursorBufferRow: 878,
        liveLastY: 25,
        visibleContentHeight: 200,
        paddingTop: 0,
        paddingBottom: 0,
        hostPaddingTop: 0,
        // DOM can currently reach only 17000, while semantic live bottom is 17380.
        containerScrollTop: 17000,
        containerScrollHeight: 17200,
        containerClientHeight: 200,
        atBottomThreshold: 8,
      });

      expect(a.bottomScrollTop).toBe(17380);
      expect(a.bottomViewportY).toBe(853);
      expect(a.isAtBottom).toBe(false);
    });

    it("cellH 0 (DOM measure not ready): falls back to geometric atBottom", () => {
      const a = computeScrollAnchor({ ...baseShortHost, cellH: 0 });
      expect(a.isAtBottom).toBe(true);
      expect(a.bottomScrollTop).toBe(0);
      expect(a.cursorInViewport).toBe(false);
    });
  });

  it("converts xterm ydisp back to container scrollTop", () => {
    expect(ydispToScrollTop(12, 20)).toBe(240);
    expect(ydispToScrollTop(-1, 20)).toBe(0);
  });
});
