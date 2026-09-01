import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevicePreviewCapability, DevicePreviewTarget } from "@dev-anywhere/shared";

const {
  requestDevicePreviewCapability,
  requestDevicePreviewTargets,
  createDevicePreview,
  navigate,
  toastError,
} = vi.hoisted(() => ({
  requestDevicePreviewCapability: vi.fn(),
  requestDevicePreviewTargets: vi.fn(),
  createDevicePreview: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    requestDevicePreviewCapability,
    requestDevicePreviewTargets,
    createDevicePreview,
  },
  wsManagerRef: null,
}));

vi.mock("@/components/toast", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

import { useAppStore } from "@/stores/app-store";
import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { CreateDevicePreviewDialog } from "./create-device-preview-dialog";

const capability: DevicePreviewCapability = {
  supported: true,
  ios: { supported: true, available: true, interactive: true, command: "baguette" },
  android: { supported: true, available: true, interactive: true, command: "adb" },
};

const target: DevicePreviewTarget = {
  targetId: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  name: "iPhone",
  state: "booted",
  interactive: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function slot<T extends Element = HTMLElement>(root: HTMLElement, name: string): T {
  const element = root.querySelector<T>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`Missing data-slot: ${name}`);
  return element;
}

describe("CreateDevicePreviewDialog", () => {
  beforeEach(() => {
    useAppStore.getState().setProxy("proxy-a", "Machine A");
    useDevicePreviewStore.getState().clear();
    requestDevicePreviewCapability.mockReset();
    requestDevicePreviewCapability.mockResolvedValue({ capability });
    requestDevicePreviewTargets.mockReset();
    requestDevicePreviewTargets.mockResolvedValue({ success: true, targets: [target] });
    createDevicePreview.mockReset();
    navigate.mockReset();
    toastError.mockReset();
  });

  afterEach(() => cleanup());

  it("discovers targets only after capability configuration finishes", async () => {
    const capabilityRequest = deferred<{ capability: DevicePreviewCapability }>();
    requestDevicePreviewCapability.mockReturnValueOnce(capabilityRequest.promise);

    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    expect(requestDevicePreviewTargets).not.toHaveBeenCalled();
    capabilityRequest.resolve({ capability });

    await waitFor(() => expect(requestDevicePreviewTargets).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-target")).toHaveAttribute(
        "data-target-id",
        target.targetId,
      ),
    );
    expect(requestDevicePreviewCapability.mock.invocationCallOrder[0]).toBeLessThan(
      requestDevicePreviewTargets.mock.invocationCallOrder[0]!,
    );
  });

  it("does not auto-select or submit a target that already has a preview", async () => {
    useDevicePreviewStore.getState().addStartingPreview({
      previewId: "existing",
      name: target.name,
      platform: target.platform,
      targetId: target.targetId,
      targetName: target.name,
      state: "ready",
      interactive: true,
      createdAt: 1,
      updatedAt: 2,
    });
    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    await waitFor(() =>
      expect(slot(baseElement, "device-preview-target")).toHaveAttribute(
        "data-already-open",
        "true",
      ),
    );
    expect(slot<HTMLButtonElement>(baseElement, "device-preview-target")).toBeDisabled();
    expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeDisabled();
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    expect(createDevicePreview).not.toHaveBeenCalled();
  });

  it("distinguishes an outdated iOS helper from a missing executable", async () => {
    requestDevicePreviewCapability.mockResolvedValueOnce({
      capability: {
        ...capability,
        ios: {
          supported: true,
          available: false,
          interactive: false,
          command: "/opt/homebrew/bin/baguette",
          version: "0.1.95",
          error: "Baguette 版本过低，请升级到 0.1.96 或更高版本",
        },
      },
    });
    requestDevicePreviewTargets.mockResolvedValueOnce({ success: true, targets: [] });

    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    await waitFor(() =>
      expect(slot(baseElement, "device-preview-tool-status")).toHaveAttribute(
        "data-status",
        "outdated",
      ),
    );
    expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeDisabled();
  });

  it("ignores an accepted create response after the dialog is externally closed", async () => {
    const createRequest = deferred<{
      operationId: string;
      accepted: boolean;
      previewId: string;
    }>();
    createDevicePreview.mockReturnValueOnce(createRequest.promise);
    const onOpenChange = vi.fn();
    const rendered = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={onOpenChange} />,
    );

    await waitFor(() =>
      expect(
        slot<HTMLButtonElement>(rendered.baseElement, "create-device-preview-submit"),
      ).not.toBeDisabled(),
    );
    fireEvent.click(slot(rendered.baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <CreateDevicePreviewDialog open={false} platform="ios" onOpenChange={onOpenChange} />,
    );
    createRequest.resolve({ operationId: "operation-one", accepted: true, previewId: "late" });
    await Promise.resolve();

    expect(useDevicePreviewStore.getState().previews).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
