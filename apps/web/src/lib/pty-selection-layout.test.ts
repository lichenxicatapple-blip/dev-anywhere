import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  computePtySelectionHandleMetrics,
  computePtySelectionToolbarPositionForHandles,
  getPtySelectionHandles,
} from "./pty-selection-layout";

describe("pty selection layout", () => {
  it("keeps handle touch targets stable while scaling the visible marker with font size", () => {
    expect(computePtySelectionHandleMetrics(12)).toEqual({
      visualSize: 8,
      stemSize: 7,
      touchSize: 44,
    });

    expect(computePtySelectionHandleMetrics(24)).toEqual({
      visualSize: 12,
      stemSize: 11,
      touchSize: 44,
    });
  });

  it("anchors the copy toolbar to the current selection handles instead of a stale touch point", () => {
    const position = computePtySelectionToolbarPositionForHandles({
      handles: {
        anchor: { left: 28, top: 680 },
        focus: { left: 212, top: 720 },
      },
      viewportWidth: 360,
      viewportHeight: 399.4,
      viewportOffsetLeft: 0,
      viewportOffsetTop: 0,
    });

    expect(position).toEqual({ left: 120, top: 335.4 });
  });

  it("keeps handle coordinates stable in the native scroll content plane", () => {
    const host = document.createElement("div");
    const screen = document.createElement("div");
    const layer = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    let scrollOffset = 0;
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20 - scrollOffset, width: 200, height: 200 }) as DOMRect;
    layer.getBoundingClientRect = () =>
      ({ left: -50, top: -100 - scrollOffset, width: 0, height: 0 }) as DOMRect;
    Object.defineProperties(screen, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
    });
    const line = { getCell: () => ({ getWidth: () => 1 }) };
    const terminal = {
      rows: 10,
      cols: 20,
      buffer: { active: { viewportY: 30, length: 80, getLine: () => line } },
    } as unknown as Terminal;
    const readHandles = () =>
      getPtySelectionHandles({
        terminal,
        host,
        coordinateSpace: layer,
        anchor: { row: 32, column: 2 },
        focus: { row: 32, column: 4 },
      });

    expect(readHandles()).toEqual({
      anchor: { left: 80, top: 180 },
      focus: { left: 110, top: 180 },
    });
    scrollOffset = 47.5;
    expect(readHandles()).toEqual({
      anchor: { left: 80, top: 180 },
      focus: { left: 110, top: 180 },
    });
  });
});
