import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { devicePreviewDialogProps, webPreviewDialogProps, mediaQuery } = vi.hoisted(() => ({
  devicePreviewDialogProps: vi.fn(),
  webPreviewDialogProps: vi.fn(),
  mediaQuery: { desktop: true },
}));

vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => mediaQuery.desktop }));

vi.mock("./create-web-preview-dialog", () => ({
  CreateWebPreviewDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    webPreviewDialogProps({ open });
    return open ? (
      <button data-slot="mock-web-preview" onClick={() => onOpenChange(false)} />
    ) : null;
  },
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
  }) => {
    devicePreviewDialogProps({ open, platform });
    return open ? (
      <button
        data-slot="mock-device-preview"
        data-platform={platform}
        onClick={() => onOpenChange(false)}
      />
    ) : null;
  },
}));

import { CreateFrontendPreviewDialog } from "./create-frontend-preview-dialog";

afterEach(() => {
  cleanup();
  devicePreviewDialogProps.mockReset();
  webPreviewDialogProps.mockReset();
  mediaQuery.desktop = true;
});

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
    if (platform) {
      expect(webPreviewDialogProps).not.toHaveBeenCalled();
    } else {
      expect(devicePreviewDialogProps).not.toHaveBeenCalled();
    }
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(panel!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes Android without ever mounting an iOS dialog and resets to the chooser", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-slot="reopen-preview-harness" onClick={() => setOpen(true)} />
          <CreateFrontendPreviewDialog open={open} onOpenChange={setOpen} />
        </>
      );
    }

    const { baseElement } = render(<Harness />);
    fireEvent.click(baseElement.querySelector('[data-slot="frontend-preview-android"]')!);
    fireEvent.click(baseElement.querySelector('[data-slot="mock-device-preview"]')!);

    expect(devicePreviewDialogProps).toHaveBeenLastCalledWith({
      open: false,
      platform: "android",
    });
    expect(
      devicePreviewDialogProps.mock.calls.some(
        ([props]) => props.open === true && props.platform === "ios",
      ),
    ).toBe(false);
    expect(baseElement.querySelector('[data-slot="create-frontend-preview-dialog"]')).toBeNull();

    fireEvent.click(baseElement.querySelector('[data-slot="reopen-preview-harness"]')!);
    expect(
      baseElement.querySelector('[data-slot="create-frontend-preview-dialog"]'),
    ).not.toBeNull();
    expect(baseElement.querySelector('[data-slot="mock-device-preview"]')).toBeNull();
  });

  it.each([
    ["frontend-preview-web", "mock-web-preview", null],
    ["frontend-preview-ios", "mock-device-preview", "ios"],
  ] as const)(
    "resets %s to the chooser only after its close transition",
    (choiceSlot, panelSlot, platform) => {
      function Harness() {
        const [open, setOpen] = useState(true);
        return (
          <>
            <button
              type="button"
              data-slot="reopen-preview-harness"
              onClick={() => setOpen(true)}
            />
            <CreateFrontendPreviewDialog open={open} onOpenChange={setOpen} />
          </>
        );
      }

      const { baseElement } = render(<Harness />);
      fireEvent.click(baseElement.querySelector(`[data-slot="${choiceSlot}"]`)!);
      const panel = baseElement.querySelector(`[data-slot="${panelSlot}"]`)!;
      if (platform) expect(panel).toHaveAttribute("data-platform", platform);

      fireEvent.click(panel);

      expect(baseElement.querySelector('[data-slot="create-frontend-preview-dialog"]')).toBeNull();
      if (platform) {
        expect(devicePreviewDialogProps).toHaveBeenLastCalledWith({ open: false, platform });
      } else {
        expect(webPreviewDialogProps).toHaveBeenLastCalledWith({ open: false });
      }

      fireEvent.click(baseElement.querySelector('[data-slot="reopen-preview-harness"]')!);

      expect(
        baseElement.querySelector('[data-slot="create-frontend-preview-dialog"]'),
      ).not.toBeNull();
      expect(baseElement.querySelector('[data-slot="mock-web-preview"]')).toBeNull();
      expect(baseElement.querySelector('[data-slot="mock-device-preview"]')).toBeNull();
    },
  );

  it("can reopen immediately and switch types without reopening the previous panel", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-slot="reopen-preview-harness" onClick={() => setOpen(true)} />
          <CreateFrontendPreviewDialog open={open} onOpenChange={setOpen} />
        </>
      );
    }

    const { baseElement } = render(<Harness />);
    fireEvent.click(baseElement.querySelector('[data-slot="frontend-preview-android"]')!);
    fireEvent.click(baseElement.querySelector('[data-slot="mock-device-preview"]')!);

    const deviceCallCountAfterClose = devicePreviewDialogProps.mock.calls.length;
    fireEvent.click(baseElement.querySelector('[data-slot="reopen-preview-harness"]')!);

    expect(
      devicePreviewDialogProps.mock.calls
        .slice(deviceCallCountAfterClose)
        .some(([props]) => props.open === true),
    ).toBe(false);
    fireEvent.click(baseElement.querySelector('[data-slot="frontend-preview-web"]')!);

    expect(baseElement.querySelector('[data-slot="mock-web-preview"]')).not.toBeNull();
    expect(baseElement.querySelector('[data-slot="mock-device-preview"]')).toBeNull();
    expect(
      devicePreviewDialogProps.mock.calls.some(
        ([props]) => props.open === true && props.platform === "ios",
      ),
    ).toBe(false);
  });

  it("uses the same single-state chooser flow for the mobile sheet", () => {
    mediaQuery.desktop = false;
    const onOpenChange = vi.fn();
    const { baseElement } = render(
      <CreateFrontendPreviewDialog open onOpenChange={onOpenChange} />,
    );

    expect(baseElement.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
    expect(webPreviewDialogProps).not.toHaveBeenCalled();
    expect(devicePreviewDialogProps).not.toHaveBeenCalled();

    fireEvent.click(baseElement.querySelector('[data-slot="frontend-preview-android"]')!);

    expect(baseElement.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
    expect(baseElement.querySelector('[data-slot="mock-device-preview"]')).toHaveAttribute(
      "data-platform",
      "android",
    );
    expect(webPreviewDialogProps).not.toHaveBeenCalled();
  });
});
