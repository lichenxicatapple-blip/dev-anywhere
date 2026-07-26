import { describe, expect, it } from "vitest";
import { computeInitialPtyGeometry } from "./pty-initial-geometry";

describe("initial PTY geometry", () => {
  it("fills a portrait phone vertically while retaining the 80-column QR baseline", () => {
    expect(
      computeInitialPtyGeometry({
        viewportWidth: 360,
        viewportHeight: 704,
        cellWidth: 8,
        cellHeight: 20,
      }),
    ).toEqual({ cols: 80, rows: 30 });
  });

  it("retains the 24-row baseline on a short landscape phone", () => {
    expect(
      computeInitialPtyGeometry({
        viewportWidth: 704,
        viewportHeight: 360,
        cellWidth: 8,
        cellHeight: 20,
      }),
    ).toEqual({ cols: 85, rows: 24 });
  });

  it("uses the available iPad viewport without device-specific breakpoints", () => {
    expect(
      computeInitialPtyGeometry({
        viewportWidth: 1024,
        viewportHeight: 768,
        cellWidth: 8,
        cellHeight: 20,
      }),
    ).toEqual({ cols: 125, rows: 34 });
  });

  it("subtracts the visible desktop sidebar", () => {
    expect(
      computeInitialPtyGeometry({
        viewportWidth: 1512,
        viewportHeight: 801,
        sidebarWidth: 280,
        cellWidth: 8,
        cellHeight: 20,
      }),
    ).toEqual({ cols: 151, rows: 36 });
  });

  it("falls back to the QR-safe baseline when the viewport is not measurable", () => {
    expect(
      computeInitialPtyGeometry({
        viewportWidth: 0,
        viewportHeight: 0,
        cellWidth: 0,
        cellHeight: 0,
      }),
    ).toEqual({ cols: 80, rows: 24 });
  });
});
