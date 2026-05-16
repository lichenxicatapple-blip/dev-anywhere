import { describe, expect, it } from "vitest";
import {
  computeHostTop,
  computePtyHostLayout,
  computeScrollAnchor,
  computeScrollTarget,
  ydispToScrollTop,
} from "./pty-scroll";

describe("PTY scroll geometry", () => {
  it("computes spacer and host dimensions from terminal metrics", () => {
    expect(
      computePtyHostLayout(
        { bufferLength: 120, rows: 24, cols: 80, viewportY: 0, cellH: 20, cellW: 10 },
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
        { bufferLength: 24, rows: 24, cols: 80, viewportY: 0, cellH: 20, cellW: 10 },
        4,
      )?.hostPaddingTop,
    ).toBe(380);
  });

  it("extends scroll space when the terminal screen is shorter than the viewport", () => {
    expect(
      computePtyHostLayout(
        {
          bufferLength: 371,
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

  it("caps long-host spacer at the cursor-aware bottom when the live cursor is near the top", () => {
    const metrics = {
      bufferLength: 209,
      rows: 54,
      cols: 270,
      viewportY: 155,
      cellH: 20,
      cellW: 8,
      visibleContentHeight: 594,
      cursorY: 13,
    };

    expect(computePtyHostLayout(metrics, 13)?.spacerHeight).toBe(3694);
  });

  it("keeps enough long-host spacer to center a mid-screen cursor without exposing trailing rows", () => {
    const metrics = {
      bufferLength: 905,
      rows: 52,
      cols: 80,
      viewportY: 853,
      cellH: 20,
      cellW: 10,
      visibleContentHeight: 200,
      cursorY: 25,
    };

    expect(computePtyHostLayout(metrics, 25)?.spacerHeight).toBe(17670);
  });

  // 移动端窄高度: rows*cellH 远大于 visibleContentHeight, cold-start padding 若按 host 自身
  // 算出 (rows-1-canvasLastY)*cellH, 会把内容压到 host 内部远低于 visible 截断点的位置,
  // 整屏看不见。padding 的"底参考"必须夹到 min(host, visible)。
  it("caps cold-start padding at visibleContentHeight when host is taller than the visible area", () => {
    const layout = computePtyHostLayout(
      {
        bufferLength: 54,
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

  it("treats an empty viewport as all but the last row blank", () => {
    expect(
      computePtyHostLayout(
        { bufferLength: 24, rows: 24, cols: 80, viewportY: 0, cellH: 20, cellW: 10 },
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

  describe("computeScrollAnchor", () => {
    const baseShortHost = {
      rows: 24,
      cellH: 20,
      bufferLength: 24,
      cursorBufferRow: 0,
      visibleContentHeight: 600,
      paddingTop: 8,
      paddingBottom: 0,
      containerScrollTop: 0,
      containerScrollHeight: 608,
      containerClientHeight: 608,
      atBottomThreshold: 8,
    } as const;

    it("short host (host <= visible): atBottom from scrollTop+clientHeight vs scrollHeight", () => {
      const a = computeScrollAnchor(baseShortHost);
      expect(a.isAtBottom).toBe(true);
      expect(a.bottomScrollTop).toBe(0);
    });

    it("short host scrolled up: not at bottom; bottomScrollTop = maxScrollTop", () => {
      const a = computeScrollAnchor({
        ...baseShortHost,
        containerScrollTop: 100,
        containerScrollHeight: 1200,
      });
      expect(a.isAtBottom).toBe(false);
      expect(a.bottomScrollTop).toBe(1200 - 608);
    });

    const baseLongHost = {
      rows: 54,
      cellH: 20,
      bufferLength: 60,
      cursorBufferRow: 8,
      visibleContentHeight: 729,
      paddingTop: 8,
      paddingBottom: 0,
      containerScrollTop: 0,
      containerScrollHeight: 1200,
      containerClientHeight: 737,
      atBottomThreshold: 8,
    } as const;

    it("long host (host > visible): atBottom = cursor pixel in viewport (not geometric bottom)", () => {
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

    it("long host: bottomScrollTop centers cursor in visible area, clamped", () => {
      // cursorPx = 168, visibleContentHeight = 729, cellH = 20
      // target = 168 - 8 - (729-20)/2 = 160 - 354.5 = -194.5
      // maxYdisp = 60-54 = 6 → minScrollTop = 120
      // maxScrollTop = 1200-737 = 463
      // 夹钳到 [120, 463]: max(120, min(463, -194.5)) = 120
      const a = computeScrollAnchor(baseLongHost);
      expect(a.bottomScrollTop).toBe(120);
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
