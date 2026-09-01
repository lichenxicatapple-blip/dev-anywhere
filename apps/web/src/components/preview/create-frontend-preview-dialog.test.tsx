import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));

vi.mock("./create-web-preview-dialog", () => ({
  CreateWebPreviewDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (open ? <button data-slot="mock-web-preview" onClick={() => onOpenChange(false)} /> : null),
}));

vi.mock("./create-device-preview-dialog", () => ({
  CreateDevicePreviewDialog: ({
    open,
    platform,
    onOpenChange,
  }: {
    open: boolean;
    platform: "ios" | "android";
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <button
        data-slot="mock-device-preview"
        data-platform={platform}
        onClick={() => onOpenChange(false)}
      />
    ) : null,
}));

import { CreateFrontendPreviewDialog } from "./create-frontend-preview-dialog";

afterEach(() => cleanup());

describe("CreateFrontendPreviewDialog", () => {
  it.each([
    ["frontend-preview-web", "mock-web-preview", null],
    ["frontend-preview-ios", "mock-device-preview", "ios"],
    ["frontend-preview-android", "mock-device-preview", "android"],
  ] as const)("hands %s off to its creation panel", (choiceSlot, panelSlot, platform) => {
    const onOpenChange = vi.fn();
    const { baseElement } = render(
      <CreateFrontendPreviewDialog open onOpenChange={onOpenChange} />,
    );

    fireEvent.click(baseElement.querySelector(`[data-slot="${choiceSlot}"]`)!);

    expect(baseElement.querySelector('[data-slot="create-frontend-preview-dialog"]')).toBeNull();
    const panel = baseElement.querySelector(`[data-slot="${panelSlot}"]`);
    expect(panel).not.toBeNull();
    if (platform) expect(panel).toHaveAttribute("data-platform", platform);
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(panel!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
