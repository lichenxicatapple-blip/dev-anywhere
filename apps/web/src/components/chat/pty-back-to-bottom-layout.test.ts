import { describe, expect, it } from "vitest";
import { getPtyBackToBottomClassName } from "./pty-back-to-bottom-layout";

describe("PTY back-to-bottom layout", () => {
  it("raises the button above the horizontal scrollbar", () => {
    const className = getPtyBackToBottomClassName({
      showMobilePtyControls: false,
      touchEditingSurface: false,
      horizontalScrollable: true,
    });

    expect(className).toContain("bottom-12");
    expect(className).toContain("right-6");
  });

  it("keeps mobile controls clearance when the soft keyboard controls are visible", () => {
    const className = getPtyBackToBottomClassName({
      showMobilePtyControls: true,
      touchEditingSurface: true,
      horizontalScrollable: true,
    });

    expect(className).toContain("7rem");
    expect(className).toContain("right-5");
  });
});
