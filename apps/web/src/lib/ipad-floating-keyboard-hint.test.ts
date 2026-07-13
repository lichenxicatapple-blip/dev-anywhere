import { beforeEach, describe, expect, it } from "vitest";
import {
  dismissFloatingKeyboardHint,
  isFloatingKeyboardHintDismissed,
  shouldShowFloatingKeyboardHint,
} from "./ipad-floating-keyboard-hint";

describe("iPad floating keyboard hint", () => {
  beforeEach(() => localStorage.clear());

  it("shows for each landscape PTY keyboard-open cycle until explicitly dismissed", () => {
    const base = {
      isIpad: true,
      isLandscape: true,
      isPty: true,
      keyboardOpen: true,
      dismissed: false,
    };

    expect(
      shouldShowFloatingKeyboardHint({
        ...base,
        shownForCurrentKeyboardOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldShowFloatingKeyboardHint({
        ...base,
        shownForCurrentKeyboardOpen: true,
      }),
    ).toBe(false);
  });

  it("does not show outside an iPad landscape PTY soft-keyboard state", () => {
    const base = {
      isIpad: true,
      isLandscape: true,
      isPty: true,
      keyboardOpen: true,
      shownForCurrentKeyboardOpen: false,
      dismissed: false,
    };

    expect(shouldShowFloatingKeyboardHint({ ...base, isIpad: false })).toBe(false);
    expect(shouldShowFloatingKeyboardHint({ ...base, isLandscape: false })).toBe(false);
    expect(shouldShowFloatingKeyboardHint({ ...base, isPty: false })).toBe(false);
    expect(shouldShowFloatingKeyboardHint({ ...base, keyboardOpen: false })).toBe(false);
  });

  it("persists only an explicit opt-out", () => {
    expect(isFloatingKeyboardHintDismissed()).toBe(false);

    dismissFloatingKeyboardHint();

    expect(isFloatingKeyboardHintDismissed()).toBe(true);
    expect(
      shouldShowFloatingKeyboardHint({
        isIpad: true,
        isLandscape: true,
        isPty: true,
        keyboardOpen: true,
        shownForCurrentKeyboardOpen: false,
        dismissed: isFloatingKeyboardHintDismissed(),
      }),
    ).toBe(false);
  });
});
