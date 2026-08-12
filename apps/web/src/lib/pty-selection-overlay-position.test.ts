import { describe, expect, it } from "vitest";
import {
  computePtySelectionToolbarPosition,
  shouldDismissPtySelectionOnContainerScroll,
} from "./pty-selection-overlay-position";

describe("computePtySelectionToolbarPosition", () => {
  it("keeps the copy toolbar inside the visual viewport when the soft keyboard is open", () => {
    expect(
      computePtySelectionToolbarPosition({
        clientX: 180,
        clientY: 650,
        viewportWidth: 360,
        viewportHeight: 399,
        viewportOffsetLeft: 0,
        viewportOffsetTop: 0,
      }),
    ).toEqual({ left: 180, top: 335 });
  });

  it("honors visual viewport offsets", () => {
    expect(
      computePtySelectionToolbarPosition({
        clientX: 12,
        clientY: 24,
        viewportWidth: 320,
        viewportHeight: 420,
        viewportOffsetLeft: 10,
        viewportOffsetTop: 20,
      }),
    ).toEqual({ left: 66, top: 76 });
  });
});

describe("shouldDismissPtySelectionOnContainerScroll", () => {
  it("preserves selection while a keyboard viewport transition moves the container", () => {
    expect(
      shouldDismissPtySelectionOnContainerScroll({
        now: 1_200,
        viewportTransitionUntil: 1_600,
        scrollLeft: 0,
        scrollTop: 320,
        selectionAutoscrollPosition: null,
      }),
    ).toBe(false);
  });

  it("dismisses selection for a later user scroll", () => {
    expect(
      shouldDismissPtySelectionOnContainerScroll({
        now: 2_000,
        viewportTransitionUntil: 1_600,
        scrollLeft: 0,
        scrollTop: 320,
        selectionAutoscrollPosition: null,
      }),
    ).toBe(true);
  });

  it("preserves the controller-owned selection autoscroll position", () => {
    expect(
      shouldDismissPtySelectionOnContainerScroll({
        now: 2_000,
        viewportTransitionUntil: 1_600,
        scrollLeft: 12,
        scrollTop: 320,
        selectionAutoscrollPosition: { scrollLeft: 12, scrollTop: 320 },
      }),
    ).toBe(false);
  });
});
