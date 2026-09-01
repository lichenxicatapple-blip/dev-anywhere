import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "@/services/relay-client";

const {
  requestDevicePreviewStream,
  consumeDevicePreviewStream,
  sendDevicePreviewInput,
  claimDevicePreviewControl,
  reconnectDevicePreview,
  onMessage,
  toastError,
  toastInfo,
} = vi.hoisted(() => ({
  requestDevicePreviewStream: vi.fn(),
  consumeDevicePreviewStream: vi.fn(),
  sendDevicePreviewInput: vi.fn(),
  claimDevicePreviewControl: vi.fn(),
  reconnectDevicePreview: vi.fn(),
  onMessage: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    requestDevicePreviewStream,
    sendDevicePreviewInput,
    claimDevicePreviewControl,
    reconnectDevicePreview,
    onMessage,
  },
  wsManagerRef: null,
}));

vi.mock("@/services/device-preview-stream", () => ({ consumeDevicePreviewStream }));

vi.mock("@/services/device-preview-frame-painter", () => ({
  LatestDevicePreviewFramePainter: class {
    constructor(
      _canvas: HTMLCanvasElement,
      private readonly onSize: (size: { width: number; height: number }) => void,
    ) {}

    enqueue(): void {
      this.onSize({ width: 100, height: 200 });
    }

    reset(): void {}
    dispose(): void {}
  },
}));

vi.mock("@/components/toast", () => ({
  toast: { error: toastError, info: toastInfo, success: vi.fn() },
}));

import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { DevicePreviewPage } from "./device-preview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function streamUntilAbort(options: { signal: AbortSignal }): Promise<void> {
  return new Promise((_, reject) => {
    options.signal.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

function slot<T extends Element = HTMLElement>(root: HTMLElement, name: string): T {
  const element = root.querySelector<T>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`Missing data-slot: ${name}`);
  return element;
}

function dispatchPointer(
  element: HTMLElement,
  type: "pointerdown" | "pointerup",
  init: { pointerId: number; clientX: number; clientY: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  fireEvent(element, event);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/preview/device/device-one"]}>
      <Routes>
        <Route path="/preview/device/:id" element={<DevicePreviewPage />} />
        <Route path="/sessions" element={<div data-slot="sessions-route" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DevicePreviewPage", () => {
  let messageHandler: ((message: InboundMessage) => void) | null;

  beforeEach(() => {
    messageHandler = null;
    useDevicePreviewStore.getState().clear();
    useDevicePreviewStore.getState().addStartingPreview({
      previewId: "device-one",
      name: "iPhone",
      platform: "ios",
      targetId: "00000000-0000-0000-0000-000000000001",
      targetName: "iPhone",
      state: "ready",
      interactive: true,
      createdAt: 1,
      updatedAt: 2,
    });
    requestDevicePreviewStream.mockReset();
    consumeDevicePreviewStream.mockReset();
    sendDevicePreviewInput.mockReset();
    sendDevicePreviewInput.mockResolvedValue({ success: true });
    claimDevicePreviewControl.mockReset();
    reconnectDevicePreview.mockReset();
    onMessage.mockReset();
    onMessage.mockImplementation((handler: (message: InboundMessage) => void) => {
      messageHandler = handler;
      return vi.fn();
    });
    toastError.mockReset();
    toastInfo.mockReset();
  });

  afterEach(() => cleanup());

  it("waits for the first frame and obtains a fresh single-use URL when reconnecting", async () => {
    const firstStream = deferred<void>();
    requestDevicePreviewStream
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-one",
        leaseId: "lease-one",
        controlMode: "controller",
      })
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-two",
        leaseId: "lease-two",
        controlMode: "controller",
      });
    consumeDevicePreviewStream
      .mockImplementationOnce(() => firstStream.promise)
      .mockImplementationOnce(
        async (
          _url: string,
          options: {
            signal: AbortSignal;
            onFrame: (frame: { sequence: number; jpeg: Uint8Array }) => void;
          },
        ) => {
          options.onFrame({ sequence: 0, jpeg: Uint8Array.of(1) });
          return streamUntilAbort(options);
        },
      );

    const { baseElement } = renderPage();
    await waitFor(() => expect(consumeDevicePreviewStream).toHaveBeenCalledTimes(1));
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
      "data-stream-status",
      "connecting",
    );
    expect(slot(baseElement, "device-preview-surface")).toHaveAttribute(
      "data-control-enabled",
      "false",
    );

    firstStream.reject(new Error("stream ended"));
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-stream-overlay")).toHaveAttribute(
        "data-stream-status",
        "error",
      ),
    );
    fireEvent.click(slot(baseElement, "device-preview-retry"));

    await waitFor(() => expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
        "data-stream-status",
        "streaming",
      ),
    );
    expect(consumeDevicePreviewStream.mock.calls.map(([url]) => url)).toEqual([
      "/api/device-preview-streams/token-one",
      "/api/device-preview-streams/token-two",
    ]);
  });

  it("keeps view-only controls disabled and ignores letterboxed pointer input", async () => {
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-viewer",
      leaseId: "lease-viewer",
      controlMode: "view_only",
    });
    consumeDevicePreviewStream.mockImplementation(
      async (
        _url: string,
        options: {
          signal: AbortSignal;
          onFrame: (frame: { sequence: number; jpeg: Uint8Array }) => void;
        },
      ) => {
        options.onFrame({ sequence: 0, jpeg: Uint8Array.of(1) });
        return streamUntilAbort(options);
      },
    );
    claimDevicePreviewControl.mockResolvedValue({
      success: true,
      controlMode: "controller",
    });

    const { baseElement } = renderPage();
    const page = await waitFor(() => {
      const element = slot(baseElement, "device-preview-page");
      expect(element).toHaveAttribute("data-stream-status", "streaming");
      return element;
    });
    expect(page).toHaveAttribute("data-control-mode", "view_only");
    expect(slot(baseElement, "device-preview-surface")).toHaveAttribute(
      "data-control-enabled",
      "false",
    );
    expect(
      baseElement.querySelector('[data-slot="device-preview-control"][data-control="home"]'),
    ).toBeDisabled();

    fireEvent.click(slot(baseElement, "device-preview-claim-control"));
    await waitFor(() => expect(page).toHaveAttribute("data-control-mode", "controller"));

    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    surface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 300,
        height: 300,
        right: 300,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    dispatchPointer(surface, "pointerdown", { pointerId: 1, clientX: 10, clientY: 150 });
    dispatchPointer(surface, "pointerup", { pointerId: 1, clientX: 10, clientY: 150 });
    expect(sendDevicePreviewInput).not.toHaveBeenCalled();

    dispatchPointer(surface, "pointerdown", { pointerId: 2, clientX: 150, clientY: 150 });
    dispatchPointer(surface, "pointerup", { pointerId: 2, clientX: 150, clientY: 150 });
    await waitFor(() =>
      expect(sendDevicePreviewInput).toHaveBeenCalledWith("lease-viewer", {
        kind: "tap",
        x: 0.5,
        y: 0.5,
      }),
    );

    act(() => {
      messageHandler?.({
        type: "device_preview_control_revoked_push",
        leaseId: "lease-viewer",
        reason: "taken_over",
      });
    });
    expect(page).toHaveAttribute("data-control-mode", "view_only");
    expect(surface).toHaveAttribute("data-control-enabled", "false");
  });
});
