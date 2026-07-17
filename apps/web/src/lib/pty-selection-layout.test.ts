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

  it("keeps selection handles operable when one endpoint scrolls outside the viewport", () => {
    const terminal = {
      rows: 10,
      cols: 20,
      buffer: { active: { viewportY: 30 } },
    } as unknown as Terminal;
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 200 }) as DOMRect;
    Object.defineProperties(screen, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
    });

    expect(
      getPtySelectionHandles({
        terminal,
        host,
        anchor: { row: 25, column: 2 },
        focus: { row: 35, column: 8 },
      }),
    ).toEqual({
      anchor: { left: 30, top: 40 },
      focus: { left: 100, top: 140 },
    });
  });
});
