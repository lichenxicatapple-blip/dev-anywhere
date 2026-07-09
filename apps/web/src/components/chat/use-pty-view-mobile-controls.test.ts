import { describe, expect, it } from "vitest";
import {
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
        keyboardOffset: 320,
      }),
    ).toBe(true);
    expect(
      resolvePtyPhysicalKeyboardMode({
        inputModePreference: "touch",
        detectedPhysicalKeyboard: true,
        keyboardOffset: 0,
      }),
    ).toBe(false);
  });

  it("keeps auto mode in touch behavior until a hardware key arrives without a soft keyboard", () => {
    expect(
      resolvePtyPhysicalKeyboardMode({
        inputModePreference: "auto",
        detectedPhysicalKeyboard: false,
        keyboardOffset: 0,
      }),
    ).toBe(false);
    expect(
      resolvePtyPhysicalKeyboardMode({
        inputModePreference: "auto",
        detectedPhysicalKeyboard: true,
        keyboardOffset: 0,
      }),
    ).toBe(true);
    expect(
      resolvePtyPhysicalKeyboardMode({
        inputModePreference: "auto",
        detectedPhysicalKeyboard: true,
        keyboardOffset: 280,
      }),
    ).toBe(false);
  });
});

describe("shouldTreatKeydownAsPhysicalKeyboardActivity", () => {
  it("recognizes useful hardware keydown events on a touch surface without a soft keyboard", () => {
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        keyboardOffset: 0,
        key: "a",
      }),
    ).toBe(true);
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        keyboardOffset: 0,
        key: "Enter",
      }),
    ).toBe(true);
  });

  it("ignores soft-keyboard, shortcut, and unrelated target keydown events", () => {
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        keyboardOffset: 320,
        key: "a",
      }),
    ).toBe(false);
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        keyboardOffset: 0,
        key: "a",
        metaKey: true,
      }),
    ).toBe(false);
    expect(
      shouldTreatKeydownAsPhysicalKeyboardActivity({
        active: true,
        touchEditingSurface: true,
        keyboardOffset: 0,
        key: "a",
        targetAcceptsPtyInput: false,
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
