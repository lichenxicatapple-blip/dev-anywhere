import { describe, expect, it } from "vitest";
import {
  computePtySelectionHandleMetrics,
  computePtySelectionToolbarPositionForHandles,
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

    expect(position).toEqual({ left: 120, top: 351.4 });
  });
});
