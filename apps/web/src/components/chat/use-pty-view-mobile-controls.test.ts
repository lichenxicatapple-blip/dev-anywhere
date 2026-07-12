import { describe, expect, it } from "vitest";
import {
  resolvePtyContainerPaddingBottom,
  resolvePtyPhysicalKeyboardMode,
  shouldForcePtyKeyboardFollow,
  shouldShowMobilePtyControlsForState,
  shouldTreatKeydownAsPhysicalKeyboardActivity,
} from "./use-pty-view";

describe("shouldShowMobilePtyControlsForState", () => {
  it("shows mobile PTY controls only after the soft keyboard is open", () => {
    expect(
      shouldShowMobilePtyControlsForState({
        softKeyboardEditingSurface: true,
        ptyInputFocused: true,
        keyboardOpen: false,
      }),
    ).toBe(false);

    expect(
      shouldShowMobilePtyControlsForState({
        softKeyboardEditingSurface: true,
        ptyInputFocused: true,
        keyboardOpen: true,
      }),
    ).toBe(true);
  });

  it("does not show controls for hardware-keyboard input or an unfocused PTY input", () => {
    expect(
      shouldShowMobilePtyControlsForState({
        softKeyboardEditingSurface: false,
        ptyInputFocused: true,
        keyboardOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldShowMobilePtyControlsForState({
        softKeyboardEditingSurface: true,
        ptyInputFocused: false,
        keyboardOpen: true,
      }),
    ).toBe(false);
  });
});

describe("resolvePtyPhysicalKeyboardMode", () => {
  it("uses explicit input preferences before adaptive detection", () => {
    expect(
      resolvePtyPhysicalKeyboardMode({
        inputModePreference: "hardware",
        detectedPhysicalKeyboard: false,
      }),
    ).toBe(true);
    expect(
      resolvePtyPhysicalKeyboardMode({
        inputModePreference: "touch",
        detectedPhysicalKeyboard: true,
      }),
    ).toBe(false);
  });

  it("keeps auto mode in touch behavior until a hardware key arrives", () => {
    expect(
      resolvePtyPhysicalKeyboardMode({
        inputModePreference: "auto",
        detectedPhysicalKeyboard: false,
      }),
    ).toBe(false);
    expect(
      resolvePtyPhysicalKeyboardMode({
        inputModePreference: "auto",
        detectedPhysicalKeyboard: true,
      }),
    ).toBe(true);
  });
});

describe("shouldTreatKeydownAsPhysicalKeyboardActivity", () => {
  it("recognizes coded hardware keydown events on a touch-capable device", () => {
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        key: "a",
        code: "KeyA",
      }),
    ).toBe(true);
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        key: "Enter",
        code: "Enter",
      }),
    ).toBe(true);
  });

  it("ignores uncoded virtual-keyboard, shortcut, and unrelated target keydown events", () => {
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        key: "a",
        code: "",
      }),
    ).toBe(false);
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        key: "a",
        code: "KeyA",
        metaKey: true,
      }),
    ).toBe(false);
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        key: "a",
        code: "KeyA",
        targetAcceptsPtyInput: false,
      }),
    ).toBe(false);
  });
});

describe("resolvePtyContainerPaddingBottom", () => {
  it("keeps existing base padding independent from bottom scroll room", () => {
    expect(
      resolvePtyContainerPaddingBottom({
        showMobilePtyControls: false,
        horizontalScrollable: false,
      }),
    ).toBe(8);
    expect(
      resolvePtyContainerPaddingBottom({
        showMobilePtyControls: false,
        horizontalScrollable: true,
      }),
    ).toBe(32);
    expect(
      resolvePtyContainerPaddingBottom({
        showMobilePtyControls: true,
        horizontalScrollable: false,
      }),
    ).toBe(112);
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
