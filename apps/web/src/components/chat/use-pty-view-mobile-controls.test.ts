import { describe, expect, it } from "vitest";
import {
  shouldForcePtyKeyboardFollow,
  shouldShowMobilePtyControlsForState,
} from "./use-pty-view";

describe("shouldShowMobilePtyControlsForState", () => {
  it("keeps mobile PTY controls visible when focused even if keyboard offset is unavailable", () => {
    expect(
      shouldShowMobilePtyControlsForState({
        softKeyboardEditingSurface: true,
        ptyInputFocused: true,
      }),
    ).toBe(true);
  });

  it("does not show controls for desktop interaction mode or an unfocused PTY input", () => {
    expect(
      shouldShowMobilePtyControlsForState({
        softKeyboardEditingSurface: false,
        ptyInputFocused: true,
      }),
    ).toBe(false);
    expect(
      shouldShowMobilePtyControlsForState({
        softKeyboardEditingSurface: true,
        ptyInputFocused: false,
      }),
    ).toBe(false);
  });
});

describe("shouldForcePtyKeyboardFollow", () => {
  it("follows output when the mobile controls first appear", () => {
    expect(
      shouldForcePtyKeyboardFollow({
        controlsVisible: true,
        keyboardOpen: false,
        previous: { controlsVisible: false, keyboardOpen: false },
      }),
    ).toBe(true);
  });

  it("follows output again when the browser later reports a keyboard inset", () => {
    expect(
      shouldForcePtyKeyboardFollow({
        controlsVisible: true,
        keyboardOpen: true,
        previous: { controlsVisible: true, keyboardOpen: false },
      }),
    ).toBe(true);
  });

  it("does not keep forcing follow while controls remain visible and keyboard state is unchanged", () => {
    expect(
      shouldForcePtyKeyboardFollow({
        controlsVisible: true,
        keyboardOpen: true,
        previous: { controlsVisible: true, keyboardOpen: true },
      }),
    ).toBe(false);
  });
});
