import { describe, expect, it } from "vitest";
import { computePtyHostLayout, computeScrollTarget, ydispToScrollTop } from "./pty-scroll";

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

  it("treats an empty viewport as all but the last row blank", () => {
    expect(
      computePtyHostLayout(
        { bufferLength: 24, rows: 24, cols: 80, viewportY: 0, cellH: 20, cellW: 10 },
        -1,
      )?.hostPaddingTop,
    ).toBe(460);
  });

  it("maps scrollTop to ydisp plus subpixel while pinned", () => {
    expect(
      computeScrollTarget(45, {
        bufferLength: 100,
        rows: 20,
        cols: 80,
        viewportY: 0,
        cellH: 20,
        cellW: 10,
      }),
    ).toEqual({ ydisp: 2, subpixel: 5 });
  });

  it("clamps to max ydisp and disables subpixel in sticky-release range", () => {
    expect(
      computeScrollTarget(2000, {
        bufferLength: 100,
        rows: 20,
        cols: 80,
        viewportY: 0,
        cellH: 20,
        cellW: 10,
      }),
    ).toEqual({ ydisp: 80, subpixel: 0 });
  });

  it("converts xterm ydisp back to container scrollTop", () => {
    expect(ydispToScrollTop(12, 20)).toBe(240);
    expect(ydispToScrollTop(-1, 20)).toBe(0);
  });
});
