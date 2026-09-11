import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { adjustPtyGeometry, measurePtyFitGeometry } from "./pty-fit-geometry";

function fixture(width = 1024, height = 716, cellWidth = 8, cellHeight = 20) {
  const container = document.createElement("div");
  container.style.padding = "8px 12px";
  Object.defineProperties(container, {
    clientWidth: { value: width },
    clientHeight: { value: height },
  });
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  Object.defineProperties(screen, {
    clientWidth: { value: cellWidth * 80 },
    clientHeight: { value: cellHeight * 24 },
  });
  host.append(screen);
  container.append(host);
  document.body.append(container);
  const terminal = { cols: 80, rows: 24 } as Terminal;
  return { measure: () => measurePtyFitGeometry(container, host, terminal), container, screen };
}

afterEach(() => document.body.replaceChildren());

describe("manual PTY adjustments", () => {
  it("changes only the requested dimension", () => {
    expect(adjustPtyGeometry({ cols: 80, rows: 24 }, "increase-cols")).toEqual({
      cols: 81,
      rows: 24,
    });
    expect(adjustPtyGeometry({ cols: 80, rows: 24 }, "increase-rows")).toEqual({
      cols: 80,
      rows: 25,
    });
    expect(adjustPtyGeometry({ cols: 80, rows: 24 }, "decrease-cols")).toEqual({
      cols: 79,
      rows: 24,
    });
    expect(adjustPtyGeometry({ cols: 80, rows: 24 }, "decrease-rows")).toEqual({
      cols: 80,
      rows: 23,
    });
  });

  it("stops at the minimum dimensions", () => {
    const size = { cols: 2, rows: 1 };
    expect(adjustPtyGeometry(size, "decrease-cols")).toEqual(size);
    expect(adjustPtyGeometry(size, "decrease-rows")).toEqual(size);
  });

  it("does not grow past the limits or shrink an already larger terminal", () => {
    for (const size of [
      { cols: 500, rows: 200 },
      { cols: 600, rows: 300 },
    ]) {
      expect(adjustPtyGeometry(size, "increase-cols")).toEqual(size);
      expect(adjustPtyGeometry(size, "increase-rows")).toEqual(size);
    }
  });
});

describe("manual PTY fit geometry", () => {
  it("grows a phone-created terminal to the current desktop content area", () => {
    expect(fixture().measure()).toEqual({ cols: 125, rows: 35 });
  });

  it("fits a phone without imposing the initial-creation 80-column minimum", () => {
    expect(fixture(360, 616).measure()).toEqual({ cols: 42, rows: 30 });
  });

  it("uses actual font metrics and the current container padding", () => {
    const { container, measure } = fixture(1024, 736, 10, 24);
    container.style.paddingBottom = "104px";
    expect(measure()).toEqual({ cols: 100, rows: 26 });
  });

  it("bounds dimensions for very large and very small viewports", () => {
    expect(fixture(100_000, 100_000).measure()).toEqual({ cols: 500, rows: 200 });
    expect(fixture(25, 17).measure()).toEqual({ cols: 2, rows: 1 });
  });

  it.each([
    [0, 700, 8, 20],
    [1000, 0, 8, 20],
    [1000, 700, 0, 20],
    [1000, 700, 8, 0],
    [Number.NaN, 700, 8, 20],
  ])("does not resize an unmeasurable terminal (%s, %s, %s, %s)", (...values) => {
    expect(fixture(...values).measure()).toBeNull();
  });

  it("does not invent a size before xterm is rendered", () => {
    const { screen, measure } = fixture();
    screen.remove();
    expect(measure()).toBeNull();
  });
});
