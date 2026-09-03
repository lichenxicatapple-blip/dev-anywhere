import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "@/services/relay-client";
import { TooltipProvider } from "@/components/ui/tooltip";

const {
  previewScope,
  scopeState,
  requestDevicePreviewStream,
  requestDevicePreviewStreamScoped,
  consumeDevicePreviewStream,
  consumeDevicePreviewH264Stream,
  h264PlayerOptions,
  h264PlayerFeed,
  h264PlayerDestroy,
  framePainterOnSize,
  sendDevicePreviewInput,
  sendDevicePreviewInputScoped,
  claimDevicePreviewControl,
  claimDevicePreviewControlScoped,
  reconnectDevicePreview,
  onMessage,
  toastError,
  toastInfo,
} = vi.hoisted(() => {
  type TestPreviewScope = Readonly<{ proxyId: string; bindingId: string }>;
  const previewScope: TestPreviewScope = Object.freeze({
    proxyId: "proxy-one",
    bindingId: "binding-one",
  });
  const scopeState: { current: TestPreviewScope } = { current: previewScope };
  const requestDevicePreviewStream = vi.fn();
  const sendDevicePreviewInput = vi.fn();
  const claimDevicePreviewControl = vi.fn();
  const scopeIsCurrent = (scope: TestPreviewScope): boolean =>
    scope.proxyId === scopeState.current.proxyId &&
    scope.bindingId === scopeState.current.bindingId;
  const requestDevicePreviewStreamScoped = vi.fn(
    async (
      scope: TestPreviewScope,
      previewId: string,
      profile: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      const result = await requestDevicePreviewStream(previewId, profile);
      options?.signal?.throwIfAborted();
      if (!scopeIsCurrent(scope)) return null;
      return {
        ...result,
        scope,
        signal: options?.signal ?? new AbortController().signal,
      };
    },
  );
  const sendDevicePreviewInputScoped = vi.fn(
    async (
      access: { scope: TestPreviewScope; leaseId: string; signal: AbortSignal },
      input: unknown,
    ) => {
      access.signal.throwIfAborted();
      if (!scopeIsCurrent(access.scope)) throw new Error("stale preview scope");
      const result = await sendDevicePreviewInput(access.leaseId, input);
      access.signal.throwIfAborted();
      if (!scopeIsCurrent(access.scope)) return null;
      return result;
    },
  );
  const claimDevicePreviewControlScoped = vi.fn(
    async (access: { scope: TestPreviewScope; leaseId: string; signal: AbortSignal }) => {
      access.signal.throwIfAborted();
      if (!scopeIsCurrent(access.scope)) throw new Error("stale preview scope");
      const result = await claimDevicePreviewControl(access.leaseId);
      access.signal.throwIfAborted();
      if (!scopeIsCurrent(access.scope)) return null;
      return result;
    },
  );
  return {
    previewScope,
    scopeState,
    requestDevicePreviewStream,
    requestDevicePreviewStreamScoped,
    consumeDevicePreviewStream: vi.fn(),
    consumeDevicePreviewH264Stream: vi.fn(),
    h264PlayerOptions: vi.fn(),
    h264PlayerFeed: vi.fn(),
    h264PlayerDestroy: vi.fn(),
    framePainterOnSize: vi.fn(),
    sendDevicePreviewInput,
    sendDevicePreviewInputScoped,
    claimDevicePreviewControl,
    claimDevicePreviewControlScoped,
    reconnectDevicePreview: vi.fn(),
    onMessage: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
  };
});

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    onMessage,
  },
  wsManagerRef: null,
}));

vi.mock("@/services/preview-controller", () => ({
  previewController: {
    getActiveScope: () => scopeState.current,
    isActive: (_relay: unknown, scope: typeof previewScope) =>
      scope.proxyId === scopeState.current.proxyId &&
      scope.bindingId === scopeState.current.bindingId,
    requestDevicePreviewStream: requestDevicePreviewStreamScoped,
    sendDevicePreviewInput: sendDevicePreviewInputScoped,
    claimDevicePreviewControl: claimDevicePreviewControlScoped,
    reconnectDevicePreview,
  },
}));

vi.mock("@/services/device-preview-stream", () => ({
  consumeDevicePreviewStream,
  consumeDevicePreviewH264Stream,
}));

vi.mock("@/services/device-preview-h264-player", () => ({
  DevicePreviewH264Player: class {
    constructor(
      _video: HTMLVideoElement,
      options: {
        onStart?: () => void;
        onError?: (error: Error) => void;
        onResyncRequired?: (error: Error) => void;
      },
    ) {
      h264PlayerOptions(options);
      options.onStart?.();
    }

    feed = h264PlayerFeed;
    destroy = h264PlayerDestroy;
  },
}));

vi.mock("@/services/device-preview-frame-painter", () => ({
  LatestDevicePreviewFramePainter: class {
    constructor(
      _canvas: HTMLCanvasElement,
      private readonly onSize: (size: { width: number; height: number }) => void,
    ) {
      framePainterOnSize(onSize);
    }

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

import { selectDevicePreviews, useDevicePreviewStore } from "@/stores/device-preview-store";
import { usePreviewOperationStore } from "@/stores/preview-operation-store";
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
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture",
  init: { pointerId: number; clientX: number; clientY: number; pointerType?: string },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  fireEvent(element, event);
}

function renderPage() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/preview/device/device-one"]}>
        <Routes>
          <Route path="/preview/device/:id" element={<DevicePreviewPage />} />
          <Route path="/sessions" element={<div data-slot="sessions-route" />} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe("DevicePreviewPage", () => {
  let messageHandler: ((message: InboundMessage) => void) | null;

  beforeEach(() => {
    messageHandler = null;
    scopeState.current = previewScope;
    useDevicePreviewStore.getState().clear();
    useDevicePreviewStore.getState().activateScope(previewScope);
    useDevicePreviewStore.getState().replaceSnapshot(previewScope, {
      epoch: "device-epoch",
      revision: 0,
      previews: [
        {
          previewId: "device-one",
          name: "iPhone",
          platform: "ios",
          targetId: "00000000-0000-0000-0000-000000000001",
          model: "iPhone 17 Pro",
          osVersion: "26.4",
          state: "ready",
          interactive: true,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    usePreviewOperationStore.getState().clear();
    requestDevicePreviewStream.mockReset();
    requestDevicePreviewStreamScoped.mockClear();
    consumeDevicePreviewStream.mockReset();
    consumeDevicePreviewH264Stream.mockReset();
    h264PlayerOptions.mockReset();
    h264PlayerFeed.mockReset();
    h264PlayerDestroy.mockReset();
    framePainterOnSize.mockReset();
    sendDevicePreviewInput.mockReset();
    sendDevicePreviewInputScoped.mockClear();
    sendDevicePreviewInput.mockResolvedValue({ success: true });
    claimDevicePreviewControl.mockReset();
    claimDevicePreviewControlScoped.mockClear();
    reconnectDevicePreview.mockReset();
    onMessage.mockReset();
    onMessage.mockImplementation((handler: (message: InboundMessage) => void) => {
      messageHandler = handler;
      return vi.fn();
    });
    toastError.mockReset();
    toastInfo.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("requests Android streams as 30 FPS H.264 without JPEG fallback", async () => {
    const preview = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    useDevicePreviewStore
      .getState()
      .applyPreviewState(previewScope, { ...preview, platform: "android" }, "device-epoch", 1);
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-android",
      leaseId: "lease-android",
      controlMode: "controller",
    });
    consumeDevicePreviewStream.mockImplementation((_url, options) => streamUntilAbort(options));
    consumeDevicePreviewH264Stream.mockImplementation((_url, options) => {
      options.onSize({ width: 324, height: 720 });
      options.onPacket({
        sequence: 1,
        kind: "frame",
        keyframe: true,
        durationMs: 33,
        data: Uint8Array.of(0, 0, 0, 1, 0x65),
      });
      return streamUntilAbort(options);
    });

    const { baseElement } = renderPage();

    await waitFor(() =>
      expect(requestDevicePreviewStream).toHaveBeenCalledWith("device-one", {
        format: "h264_annex_b",
      }),
    );
    expect(consumeDevicePreviewStream).not.toHaveBeenCalled();
    expect(h264PlayerFeed).toHaveBeenCalledWith({
      sequence: 1,
      kind: "frame",
      keyframe: true,
      durationMs: 33,
      data: Uint8Array.of(0, 0, 0, 1, 0x65),
    });
    const shell = slot(baseElement, "device-preview-device-shell");
    const chrome = slot(baseElement, "device-preview-device-chrome");
    const surface = slot(baseElement, "device-preview-surface");
    const video = slot(baseElement, "device-preview-video");
    expect(shell).toHaveAttribute("data-platform", "android");
    expect(shell).toHaveAttribute("data-orientation", "portrait");
    expect(shell.style.aspectRatio).toBe("324 / 720");
    expect(chrome).toHaveAttribute("data-platform", "android");
    expect(chrome).toHaveAttribute("data-orientation", "portrait");
    expect(chrome.parentElement).toBe(shell);
    expect(surface.parentElement).toBe(shell);
    expect(video.parentElement).toBe(surface);
    expect(slot(baseElement, "device-preview-control-dock")).toHaveAttribute(
      "data-orientation",
      "portrait",
    );

    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 720 },
      videoHeight: { configurable: true, value: 324 },
    });
    fireEvent(video, new Event("resize"));
    await waitFor(() => expect(shell).toHaveAttribute("data-orientation", "landscape"));
    expect(shell.style.aspectRatio).toBe("720 / 324");
    expect(slot(baseElement, "device-preview-control-dock")).toHaveAttribute(
      "data-orientation",
      "landscape",
    );

    fireEvent.click(
      baseElement.querySelector('[data-slot="device-preview-control"][data-control="home"]')!,
    );
    fireEvent.click(
      baseElement.querySelector('[data-slot="device-preview-control"][data-control="back"]')!,
    );
    fireEvent.click(
      baseElement.querySelector(
        '[data-slot="device-preview-control"][data-control="orientation"]',
      )!,
    );
    await waitFor(() => expect(sendDevicePreviewInput).toHaveBeenCalledTimes(3));
    expect(sendDevicePreviewInput).toHaveBeenNthCalledWith(1, "lease-android", {
      kind: "button",
      button: "home",
    });
    expect(sendDevicePreviewInput).toHaveBeenNthCalledWith(2, "lease-android", {
      kind: "button",
      button: "back",
    });
    expect(sendDevicePreviewInput).toHaveBeenNthCalledWith(3, "lease-android", {
      kind: "orientation",
      orientation: "portrait",
    });
  });

  it("adapts the iPhone shell to the captured frame orientation", async () => {
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-ios-shell",
      leaseId: "lease-ios-shell",
      controlMode: "controller",
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

    const { baseElement } = renderPage();
    const shell = await waitFor(() => {
      const element = slot(baseElement, "device-preview-device-shell");
      expect(element).toHaveAttribute("data-orientation", "portrait");
      return element;
    });
    const chrome = slot(baseElement, "device-preview-device-chrome");
    const surface = slot(baseElement, "device-preview-surface");

    expect(shell).toHaveAttribute("data-platform", "ios");
    expect(shell.style.aspectRatio).toBe("100 / 200");
    expect(chrome).toHaveAttribute("aria-hidden", "true");
    expect(chrome).toHaveAttribute("data-platform", "ios");
    expect(chrome).toHaveAttribute("data-orientation", "portrait");
    expect(chrome).toHaveClass("pointer-events-none");
    expect(surface.parentElement).toBe(shell);

    const onSize = framePainterOnSize.mock.calls[0]?.[0] as
      | ((size: { width: number; height: number }) => void)
      | undefined;
    expect(onSize).toBeTypeOf("function");
    act(() => onSize?.({ width: 720, height: 331 }));

    expect(shell).toHaveAttribute("data-orientation", "landscape");
    expect(shell.style.aspectRatio).toBe("720 / 331");
    expect(shell.style.width).toContain("720px");
    expect(chrome).toHaveAttribute("data-orientation", "landscape");
  });

  it("drops a deferred stream access when the same Proxy gets a new binding", async () => {
    const staleAccess = deferred<{
      previewId: string;
      success: boolean;
      url: string;
      leaseId: string;
      controlMode: "controller";
    }>();
    requestDevicePreviewStream.mockReturnValueOnce(staleAccess.promise).mockResolvedValueOnce({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/current-token",
      leaseId: "current-lease",
      controlMode: "controller",
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
    const preview = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;

    const { baseElement } = renderPage();
    await waitFor(() => expect(requestDevicePreviewStreamScoped).toHaveBeenCalledTimes(1));

    const currentScope = Object.freeze({
      proxyId: previewScope.proxyId,
      bindingId: "binding-two",
    });
    act(() => {
      scopeState.current = currentScope;
      useDevicePreviewStore.getState().activateScope(currentScope);
      useDevicePreviewStore.getState().replaceSnapshot(currentScope, {
        epoch: "device-epoch-two",
        revision: 0,
        previews: [preview],
      });
    });

    await waitFor(() => expect(requestDevicePreviewStreamScoped).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(consumeDevicePreviewStream).toHaveBeenCalledWith(
        "/api/device-preview-streams/current-token",
        expect.any(Object),
      ),
    );

    await act(async () => {
      staleAccess.resolve({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/stale-token",
        leaseId: "stale-lease",
        controlMode: "controller",
      });
      await Promise.resolve();
    });

    expect(requestDevicePreviewStreamScoped.mock.calls.map(([scope]) => scope)).toEqual([
      previewScope,
      currentScope,
    ]);
    expect(consumeDevicePreviewStream.mock.calls.map(([url]) => url)).toEqual([
      "/api/device-preview-streams/current-token",
    ]);
    const page = slot(baseElement, "device-preview-page");
    expect(page).toHaveAttribute("data-control-mode", "controller");

    act(() => {
      messageHandler?.({
        type: "device_preview_control_revoked_push",
        scope: previewScope,
        // Deliberately collide with the current lease: binding scope, not leaseId alone, must
        // distinguish a delayed revoke from the superseded binding.
        leaseId: "current-lease",
        reason: "taken_over",
      });
    });

    expect(page).toHaveAttribute("data-control-mode", "controller");
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("stops the Android player when H.264 playback fails", async () => {
    const preview = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    useDevicePreviewStore
      .getState()
      .applyPreviewState(previewScope, { ...preview, platform: "android" }, "device-epoch", 1);
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-android-error",
      leaseId: "lease-android-error",
      controlMode: "controller",
    });
    consumeDevicePreviewH264Stream.mockImplementation((_url, options) => streamUntilAbort(options));

    const { baseElement } = renderPage();
    await waitFor(() => expect(h264PlayerOptions).toHaveBeenCalledTimes(1));

    act(() => {
      h264PlayerOptions.mock.calls[0]?.[0].onError?.(new Error("H.264 解码失败"));
    });

    await waitFor(() =>
      expect(slot(baseElement, "device-preview-stream-overlay")).toHaveAttribute(
        "data-stream-status",
        "error",
      ),
    );
    expect(h264PlayerDestroy).toHaveBeenCalled();
  });

  it("reconnects Android with a fresh stream URL when H.264 playback requires resync", async () => {
    vi.useFakeTimers();
    const preview = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    useDevicePreviewStore
      .getState()
      .applyPreviewState(previewScope, { ...preview, platform: "android" }, "device-epoch", 1);
    requestDevicePreviewStream
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-android-old",
        leaseId: "lease-android-old",
        controlMode: "controller",
      })
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-android-fresh",
        leaseId: "lease-android-fresh",
        controlMode: "controller",
      });
    const streamSignals: AbortSignal[] = [];
    consumeDevicePreviewH264Stream.mockImplementation((_url, options) => {
      streamSignals.push(options.signal);
      return streamUntilAbort(options);
    });

    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(1);
    expect(h264PlayerOptions).toHaveBeenCalledTimes(1);

    act(() => {
      h264PlayerOptions.mock.calls[0]?.[0].onResyncRequired?.(
        new Error("H.264 playback buffer overflowed"),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(streamSignals[0]?.aborted).toBe(true);
    expect(h264PlayerDestroy).toHaveBeenCalledTimes(1);
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);
    expect(consumeDevicePreviewH264Stream.mock.calls.map(([url]) => url)).toEqual([
      "/api/device-preview-streams/token-android-old",
      "/api/device-preview-streams/token-android-fresh",
    ]);
    expect(h264PlayerOptions).toHaveBeenCalledTimes(2);
  });

  it.each(["stream_closed", "lease_expired", "proxy_offline"] as const)(
    "closes a revoked %s access and reconnects with a fresh lease",
    async (reason) => {
      vi.useFakeTimers();
      requestDevicePreviewStream
        .mockResolvedValueOnce({
          previewId: "device-one",
          success: true,
          url: "/api/device-preview-streams/token-revoked",
          leaseId: "lease-revoked",
          controlMode: "controller",
        })
        .mockResolvedValueOnce({
          previewId: "device-one",
          success: true,
          url: "/api/device-preview-streams/token-after-revoke",
          leaseId: "lease-after-revoke",
          controlMode: "controller",
        });
      const streamSignals: AbortSignal[] = [];
      consumeDevicePreviewStream.mockImplementation(
        async (
          _url: string,
          options: {
            signal: AbortSignal;
            onFrame: (frame: { sequence: number; jpeg: Uint8Array }) => void;
          },
        ) => {
          streamSignals.push(options.signal);
          options.onFrame({ sequence: 0, jpeg: Uint8Array.of(1) });
          return streamUntilAbort(options);
        },
      );

      const { baseElement } = renderPage();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const page = slot(baseElement, "device-preview-page");
      expect(page).toHaveAttribute("data-stream-status", "streaming");

      act(() => {
        messageHandler?.({
          type: "device_preview_control_revoked_push",
          scope: previewScope,
          leaseId: "lease-revoked",
          reason,
        });
      });

      expect(streamSignals[0]?.aborted).toBe(true);
      expect(page).toHaveAttribute("data-stream-status", "error");
      expect(page).toHaveAttribute("data-control-mode", "none");
      expect(toastError).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);
      expect(page).toHaveAttribute("data-stream-status", "streaming");
      expect(page).toHaveAttribute("data-control-mode", "controller");
      expect(streamSignals[1]?.aborted).toBe(false);

      act(() => {
        messageHandler?.({
          type: "device_preview_control_revoked_push",
          scope: previewScope,
          leaseId: "lease-revoked",
          reason,
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);
      expect(page).toHaveAttribute("data-stream-status", "streaming");
      expect(streamSignals[1]?.aborted).toBe(false);
    },
  );

  it("observes a revoke that arrives while the first stream access is being attached", async () => {
    vi.useFakeTimers();
    requestDevicePreviewStream
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-revoked-during-attach",
        leaseId: "lease-revoked-during-attach",
        controlMode: "controller",
      })
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-after-attach-revoke",
        leaseId: "lease-after-attach-revoke",
        controlMode: "controller",
      });
    consumeDevicePreviewStream
      .mockImplementationOnce(async () => {
        messageHandler?.({
          type: "device_preview_control_revoked_push",
          scope: previewScope,
          leaseId: "lease-revoked-during-attach",
          reason: "stream_closed",
        });
      })
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const page = slot(baseElement, "device-preview-page");
    expect(page).toHaveAttribute("data-stream-status", "error");
    expect(page).toHaveAttribute("data-control-mode", "none");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);
    expect(page).toHaveAttribute("data-stream-status", "streaming");
    expect(page).toHaveAttribute("data-control-mode", "controller");
  });

  it("backs off streams that fail after one frame and resets only after a stable window", async () => {
    vi.useFakeTimers();
    const streams = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    let accessIndex = 0;
    let streamIndex = 0;
    requestDevicePreviewStream.mockImplementation(async () => {
      accessIndex += 1;
      return {
        previewId: "device-one",
        success: true,
        url: `/api/device-preview-streams/token-flap-${accessIndex}`,
        leaseId: `lease-flap-${accessIndex}`,
        controlMode: "controller",
      };
    });
    consumeDevicePreviewStream.mockImplementation(
      async (
        _url: string,
        options: {
          signal: AbortSignal;
          onFrame: (frame: { sequence: number; jpeg: Uint8Array }) => void;
        },
      ) => {
        const stream = streams[streamIndex];
        streamIndex += 1;
        options.onFrame({ sequence: 0, jpeg: Uint8Array.of(1) });
        return stream?.promise ?? new Promise<void>(() => {});
      },
    );

    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      streams[0]?.reject(new Error("first flap"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);

    await act(async () => {
      streams[1]?.reject(new Error("second flap"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      streams[2]?.reject(new Error("failure after stable window"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(4);
  });

  it("opens paste entry on demand and sends text from the compact dock", async () => {
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-text",
      leaseId: "lease-text",
      controlMode: "controller",
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

    const { baseElement } = renderPage();
    const toggle = await waitFor(() => {
      const element = slot<HTMLButtonElement>(baseElement, "device-preview-text-toggle");
      expect(element).toBeEnabled();
      return element;
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(baseElement.querySelector('[data-slot="device-preview-text-form"]')).toBeNull();

    fireEvent.click(toggle);
    const form = await waitFor(() =>
      slot<HTMLFormElement>(baseElement, "device-preview-text-form"),
    );
    const input = slot<HTMLTextAreaElement>(baseElement, "device-preview-text-input");
    const pastedText = "第一行\nemoji 👋🏽\n第三行";
    fireEvent.change(input, { target: { value: pastedText } });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(sendDevicePreviewInput).toHaveBeenCalledWith("lease-text", {
        kind: "text",
        text: pastedText,
      }),
    );
    await waitFor(() =>
      expect(baseElement.querySelector('[data-slot="device-preview-text-form"]')).toBeNull(),
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

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

  it("stops local stream retries when authoritative discovery marks the target disconnected", async () => {
    vi.useFakeTimers();
    const stream = deferred<void>();
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-before-disconnect",
      leaseId: "lease-before-disconnect",
      controlMode: "controller",
    });
    consumeDevicePreviewStream.mockImplementation(() => stream.promise);

    const { baseElement } = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      stream.reject(new Error("capture stopped"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute("data-stream-status", "error");

    const ready = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    act(() => {
      useDevicePreviewStore
        .getState()
        .applyPreviewState(
          previewScope,
          { ...ready, state: "disconnected", updatedAt: 3 },
          "device-epoch",
          1,
        );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(1);
    expect(slot(baseElement, "device-preview-stream-overlay")).toHaveAttribute(
      "data-stream-status",
      "error",
    );
  });

  it("waits for the authoritative ready push before streaming a reconnected target", async () => {
    const ready = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    useDevicePreviewStore
      .getState()
      .applyPreviewState(
        previewScope,
        { ...ready, state: "disconnected", updatedAt: 3 },
        "device-epoch",
        1,
      );
    reconnectDevicePreview.mockResolvedValue({ success: true });
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-after-reconnect",
      leaseId: "lease-after-reconnect",
      controlMode: "controller",
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

    const { baseElement } = renderPage();
    expect(requestDevicePreviewStream).not.toHaveBeenCalled();
    fireEvent.click(slot(baseElement, "device-preview-retry"));
    await waitFor(() =>
      expect(reconnectDevicePreview).toHaveBeenCalledWith(previewScope, "device-one"),
    );
    expect(requestDevicePreviewStream).not.toHaveBeenCalled();

    const disconnected = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    act(() => {
      useDevicePreviewStore
        .getState()
        .applyPreviewState(
          previewScope,
          { ...disconnected, state: "ready", updatedAt: 4 },
          "device-epoch",
          2,
        );
    });

    await waitFor(() => expect(requestDevicePreviewStream).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
        "data-stream-status",
        "streaming",
      ),
    );
  });

  it("streams every iOS gesture as phased touch", async () => {
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-ios-touch",
      leaseId: "lease-ios-touch",
      controlMode: "controller",
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

    const { baseElement } = renderPage();
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
        "data-stream-status",
        "streaming",
      ),
    );
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    let pointerNow = 0;
    const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => pointerNow);
    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 20,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });
    pointerNow = 100;
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 20,
      pointerType: "touch",
      clientX: 180,
      clientY: 250,
    });
    pointerNow = 105;
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 20,
      pointerType: "touch",
      clientX: 190,
      clientY: 250,
    });
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 20,
      pointerType: "touch",
      clientX: 300,
      clientY: 250,
    });

    await waitFor(() => expect(sendDevicePreviewInput).toHaveBeenCalledTimes(3));
    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-ios-touch", { kind: "touch", phase: "down", x: 0.1, y: 0.5 }],
      ["lease-ios-touch", { kind: "touch", phase: "move", x: 0.4, y: 0.5 }],
      ["lease-ios-touch", { kind: "touch", phase: "up", x: 1, y: 0.5 }],
    ]);

    pointerNow = 200;
    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 22,
      pointerType: "touch",
      clientX: 220,
      clientY: 250,
    });
    pointerNow = 300;
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 22,
      pointerType: "touch",
      clientX: 220,
      clientY: 250,
    });
    performanceNow.mockRestore();

    await waitFor(() => expect(sendDevicePreviewInput).toHaveBeenCalledTimes(5));
    expect(sendDevicePreviewInput.mock.calls.slice(-2)).toEqual([
      ["lease-ios-touch", { kind: "touch", phase: "down", x: 0.6, y: 0.5 }],
      ["lease-ios-touch", { kind: "touch", phase: "up", x: 0.6, y: 0.5 }],
    ]);
  });

  it("flushes the latest move after the frame window without another pointer event", async () => {
    vi.useFakeTimers();
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-ios-throttled-move",
      leaseId: "lease-ios-throttled-move",
      controlMode: "controller",
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

    const { baseElement } = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
      "data-stream-status",
      "streaming",
    );
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    let pointerNow = 0;
    const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => pointerNow);
    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 23,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });
    pointerNow = 100;
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 23,
      pointerType: "touch",
      clientX: 160,
      clientY: 250,
    });
    pointerNow = 105;
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 23,
      pointerType: "touch",
      clientX: 180,
      clientY: 250,
    });

    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-ios-throttled-move", { kind: "touch", phase: "down", x: 0.1, y: 0.5 }],
      ["lease-ios-throttled-move", { kind: "touch", phase: "move", x: 0.3, y: 0.5 }],
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(sendDevicePreviewInput.mock.calls.at(-1)).toEqual([
      "lease-ios-throttled-move",
      { kind: "touch", phase: "move", x: 0.4, y: 0.5 },
    ]);

    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 23,
      pointerType: "touch",
      clientX: 180,
      clientY: 250,
    });
    performanceNow.mockRestore();
  });

  it("uses the same phased touch path for Android drags", async () => {
    const preview = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    useDevicePreviewStore
      .getState()
      .applyPreviewState(previewScope, { ...preview, platform: "android" }, "device-epoch", 1);
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-android-touch",
      leaseId: "lease-android-touch",
      controlMode: "controller",
    });
    consumeDevicePreviewH264Stream.mockImplementation((_url, options) => {
      options.onSize({ width: 100, height: 200 });
      return streamUntilAbort(options);
    });

    const { baseElement } = renderPage();
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
        "data-stream-status",
        "streaming",
      ),
    );
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 30,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 30,
      pointerType: "touch",
      clientX: 180,
      clientY: 250,
    });
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 30,
      pointerType: "touch",
      clientX: 250,
      clientY: 250,
    });

    await waitFor(() => expect(sendDevicePreviewInput).toHaveBeenCalledTimes(3));
    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-android-touch", { kind: "touch", phase: "down", x: 0.1, y: 0.5 }],
      ["lease-android-touch", { kind: "touch", phase: "move", x: 0.4, y: 0.5 }],
      ["lease-android-touch", { kind: "touch", phase: "up", x: 0.75, y: 0.5 }],
    ]);
  });

  it("maps Android landscape touches in screen coordinates", async () => {
    const preview = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    useDevicePreviewStore
      .getState()
      .applyPreviewState(previewScope, { ...preview, platform: "android" }, "device-epoch", 1);
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-android-landscape-touch",
      leaseId: "lease-android-landscape-touch",
      controlMode: "controller",
    });
    consumeDevicePreviewH264Stream.mockImplementation((_url, options) => {
      options.onSize({ width: 200, height: 100 });
      return streamUntilAbort(options);
    });

    const { baseElement } = renderPage();
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
        "data-stream-status",
        "streaming",
      ),
    );
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 400,
        height: 200,
        right: 500,
        bottom: 250,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 50,
      pointerType: "touch",
      clientX: 120,
      clientY: 70,
    });
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 50,
      pointerType: "touch",
      clientX: 260,
      clientY: 70,
    });
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 50,
      pointerType: "touch",
      clientX: 340,
      clientY: 90,
    });

    await waitFor(() => expect(sendDevicePreviewInput).toHaveBeenCalledTimes(3));
    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-android-landscape-touch", { kind: "touch", phase: "down", x: 0.05, y: 0.1 }],
      ["lease-android-landscape-touch", { kind: "touch", phase: "move", x: 0.4, y: 0.1 }],
      ["lease-android-landscape-touch", { kind: "touch", phase: "up", x: 0.6, y: 0.2 }],
    ]);
  });

  it("keeps one active pointer, ignores another, and accepts the next gesture", async () => {
    vi.useFakeTimers();
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-ios-single-touch",
      leaseId: "lease-ios-single-touch",
      controlMode: "controller",
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

    const { baseElement } = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    let pointerNow = 0;
    const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => pointerNow);
    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 61,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });
    pointerNow = 20;
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 61,
      pointerType: "touch",
      clientX: 180,
      clientY: 250,
    });

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 62,
      pointerType: "touch",
      clientX: 280,
      clientY: 250,
    });
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 62,
      pointerType: "touch",
      clientX: 220,
      clientY: 250,
    });
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 62,
      pointerType: "touch",
      clientX: 160,
      clientY: 250,
    });
    expect(sendDevicePreviewInput).toHaveBeenCalledTimes(2);

    pointerNow = 40;
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 61,
      pointerType: "touch",
      clientX: 250,
      clientY: 250,
    });
    pointerNow = 60;
    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 63,
      pointerType: "touch",
      clientX: 200,
      clientY: 430,
    });
    pointerNow = 80;
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 63,
      pointerType: "touch",
      clientX: 200,
      clientY: 350,
    });
    performanceNow.mockRestore();

    expect(inputSurface.setPointerCapture).toHaveBeenCalledTimes(2);
    expect(inputSurface.setPointerCapture).toHaveBeenNthCalledWith(1, 61);
    expect(inputSurface.setPointerCapture).toHaveBeenNthCalledWith(2, 63);
    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-ios-single-touch", { kind: "touch", phase: "down", x: 0.1, y: 0.5 }],
      ["lease-ios-single-touch", { kind: "touch", phase: "move", x: 0.4, y: 0.5 }],
      ["lease-ios-single-touch", { kind: "touch", phase: "up", x: 0.75, y: 0.5 }],
      ["lease-ios-single-touch", { kind: "touch", phase: "down", x: 0.5, y: 0.95 }],
      ["lease-ios-single-touch", { kind: "touch", phase: "up", x: 0.5, y: 0.75 }],
    ]);
  });

  it("keeps a long press down until pointer release without synthetic moves", async () => {
    vi.useFakeTimers();
    const preview = selectDevicePreviews(useDevicePreviewStore.getState())[0]!;
    useDevicePreviewStore
      .getState()
      .applyPreviewState(previewScope, { ...preview, platform: "android" }, "device-epoch", 1);
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-android-hold",
      leaseId: "lease-android-hold",
      controlMode: "controller",
    });
    consumeDevicePreviewH264Stream.mockImplementation((_url, options) => {
      options.onSize({ width: 100, height: 200 });
      return streamUntilAbort(options);
    });

    const { baseElement } = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
      "data-stream-status",
      "streaming",
    );
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 40,
      pointerType: "touch",
      clientX: 200,
      clientY: 250,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendDevicePreviewInput).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(sendDevicePreviewInput).toHaveBeenCalledTimes(1);

    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 40,
      pointerType: "touch",
      clientX: 200,
      clientY: 250,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendDevicePreviewInput.mock.calls.at(-1)?.[1]).toEqual({
      kind: "touch",
      phase: "up",
      x: 0.5,
      y: 0.5,
    });
    const callsAfterRelease = sendDevicePreviewInput.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(sendDevicePreviewInput).toHaveBeenCalledTimes(callsAfterRelease);
  });

  it("ends a touch at its last point when pointer capture is cancelled", async () => {
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-ios-cancel",
      leaseId: "lease-ios-cancel",
      controlMode: "controller",
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

    const { baseElement } = renderPage();
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
        "data-stream-status",
        "streaming",
      ),
    );
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 21,
      pointerType: "touch",
      clientX: 200,
      clientY: 430,
    });
    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 21,
      pointerType: "touch",
      clientX: 200,
      clientY: 300,
    });
    expect(sendDevicePreviewInput).toHaveBeenCalledTimes(2);
    expect(
      sendDevicePreviewInput.mock.calls.some(
        ([, input]) => input.kind === "touch" && input.phase === "up",
      ),
    ).toBe(false);
    dispatchPointer(inputSurface, "pointercancel", {
      pointerId: 21,
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    });
    dispatchPointer(inputSurface, "lostpointercapture", {
      pointerId: 21,
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    });

    await waitFor(() => expect(sendDevicePreviewInput).toHaveBeenCalledTimes(3));
    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-ios-cancel", { kind: "touch", phase: "down", x: 0.5, y: 0.95 }],
      ["lease-ios-cancel", { kind: "touch", phase: "move", x: 0.5, y: 0.625 }],
      ["lease-ios-cancel", { kind: "touch", phase: "up", x: 0.5, y: 0.625 }],
    ]);
  });

  it("fails the access closed and reconnects with a fresh lease when touch down fails", async () => {
    vi.useFakeTimers();
    requestDevicePreviewStream
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-ios-down-failure",
        leaseId: "lease-ios-down-failure",
        controlMode: "controller",
      })
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-ios-after-failure",
        leaseId: "lease-ios-after-failure",
        controlMode: "controller",
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
    sendDevicePreviewInput
      .mockResolvedValueOnce({ success: false, error: "touch failed" })
      .mockResolvedValue({ success: true });

    const { baseElement } = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
      "data-stream-status",
      "streaming",
    );
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 41,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-ios-down-failure", { kind: "touch", phase: "down", x: 0.1, y: 0.5 }],
    ]);
    expect(toastError).toHaveBeenCalledOnce();
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute("data-stream-status", "error");
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(1);

    dispatchPointer(inputSurface, "pointermove", {
      pointerId: 41,
      pointerType: "touch",
      clientX: 180,
      clientY: 250,
    });
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 41,
      pointerType: "touch",
      clientX: 220,
      clientY: 250,
    });
    expect(sendDevicePreviewInput).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
      "data-stream-status",
      "streaming",
    );

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 43,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 43,
      pointerType: "touch",
      clientX: 180,
      clientY: 250,
    });
    expect(sendDevicePreviewInput.mock.calls.slice(-2)).toEqual([
      ["lease-ios-after-failure", { kind: "touch", phase: "down", x: 0.1, y: 0.5 }],
      ["lease-ios-after-failure", { kind: "touch", phase: "up", x: 0.4, y: 0.5 }],
    ]);
  });

  it("fails the access closed when the final touch up is not acknowledged", async () => {
    vi.useFakeTimers();
    requestDevicePreviewStream
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-ios-up-failure",
        leaseId: "lease-ios-up-failure",
        controlMode: "controller",
      })
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-ios-after-up-failure",
        leaseId: "lease-ios-after-up-failure",
        controlMode: "controller",
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
    sendDevicePreviewInput.mockImplementation((leaseId, input) => {
      if (leaseId === "lease-ios-up-failure" && input.kind === "touch" && input.phase === "up") {
        return Promise.resolve({ success: false, error: "release was not acknowledged" });
      }
      return Promise.resolve({ success: true });
    });

    const { baseElement } = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
      "data-stream-status",
      "streaming",
    );
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 42,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 42,
      pointerType: "touch",
      clientX: 180,
      clientY: 250,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-ios-up-failure", { kind: "touch", phase: "down", x: 0.1, y: 0.5 }],
      ["lease-ios-up-failure", { kind: "touch", phase: "up", x: 0.4, y: 0.5 }],
    ]);
    expect(toastError).toHaveBeenCalledOnce();
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute("data-stream-status", "error");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
      "data-stream-status",
      "streaming",
    );
  });

  it("shares the in-flight move window across gestures on one lease", async () => {
    vi.useFakeTimers();
    requestDevicePreviewStream.mockResolvedValue({
      previewId: "device-one",
      success: true,
      url: "/api/device-preview-streams/token-ios-move-window",
      leaseId: "lease-ios-move-window",
      controlMode: "controller",
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
    const moveRequests: Array<ReturnType<typeof deferred<{ success: boolean }>>> = [];
    sendDevicePreviewInput.mockImplementation((_leaseId, input) => {
      if (input.kind === "touch" && input.phase === "move") {
        const request = deferred<{ success: boolean }>();
        moveRequests.push(request);
        return request.promise;
      }
      return Promise.resolve({ success: true });
    });

    const { baseElement } = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    let pointerNow = 0;
    const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => pointerNow);
    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 43,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });
    for (let index = 0; index < 20; index += 1) {
      pointerNow += 20;
      dispatchPointer(inputSurface, "pointermove", {
        pointerId: 43,
        pointerType: "touch",
        clientX: 110 + index * 5,
        clientY: 250,
      });
    }

    expect(moveRequests).toHaveLength(16);
    expect(sendDevicePreviewInput).toHaveBeenCalledTimes(17);
    dispatchPointer(inputSurface, "pointerup", {
      pointerId: 43,
      pointerType: "touch",
      clientX: 250,
      clientY: 250,
    });
    expect(sendDevicePreviewInput.mock.calls.at(-1)).toEqual([
      "lease-ios-move-window",
      { kind: "touch", phase: "up", x: 0.75, y: 0.5 },
    ]);

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 45,
      pointerType: "touch",
      clientX: 200,
      clientY: 430,
    });
    for (let index = 0; index < 20; index += 1) {
      pointerNow += 20;
      dispatchPointer(inputSurface, "pointermove", {
        pointerId: 45,
        pointerType: "touch",
        clientX: 200,
        clientY: 350,
      });
    }

    // The old gesture still owns all 16 move slots. A new gesture on the same lease may queue one
    // latest point, but it must not open another 16-slot window and overflow the Proxy's lease queue.
    expect(moveRequests).toHaveLength(16);
    expect(sendDevicePreviewInput.mock.calls.at(-1)).toEqual([
      "lease-ios-move-window",
      { kind: "touch", phase: "down", x: 0.5, y: 0.95 },
    ]);

    await act(async () => {
      moveRequests[0]?.resolve({ success: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(moveRequests).toHaveLength(17);
    expect(sendDevicePreviewInput.mock.calls.at(-1)).toEqual([
      "lease-ios-move-window",
      { kind: "touch", phase: "move", x: 0.5, y: 0.75 },
    ]);

    dispatchPointer(inputSurface, "pointercancel", {
      pointerId: 45,
      pointerType: "touch",
      clientX: 200,
      clientY: 350,
    });

    await act(async () => {
      for (const request of moveRequests.slice(1)) request.resolve({ success: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      sendDevicePreviewInput.mock.calls.filter(
        ([, input]) => input.kind === "touch" && input.phase === "move",
      ),
    ).toHaveLength(17);
    expect(sendDevicePreviewInput.mock.calls.at(-1)).toEqual([
      "lease-ios-move-window",
      { kind: "touch", phase: "up", x: 0.5, y: 0.75 },
    ]);
    performanceNow.mockRestore();
  });

  it("starts a fresh move window when the stream receives a new lease", async () => {
    vi.useFakeTimers();
    requestDevicePreviewStream
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-ios-old-lease",
        leaseId: "lease-ios-old",
        controlMode: "controller",
      })
      .mockResolvedValueOnce({
        previewId: "device-one",
        success: true,
        url: "/api/device-preview-streams/token-ios-new-lease",
        leaseId: "lease-ios-new",
        controlMode: "controller",
      });
    const streamRequests: Array<ReturnType<typeof deferred<void>>> = [];
    consumeDevicePreviewStream.mockImplementation(
      async (
        _url: string,
        options: {
          signal: AbortSignal;
          onFrame: (frame: { sequence: number; jpeg: Uint8Array }) => void;
        },
      ) => {
        options.onFrame({ sequence: 0, jpeg: Uint8Array.of(1) });
        const request = deferred<void>();
        streamRequests.push(request);
        return request.promise;
      },
    );
    const moveRequests: Array<{
      leaseId: string;
      request: ReturnType<typeof deferred<{ success: boolean }>>;
    }> = [];
    sendDevicePreviewInput.mockImplementation((leaseId, input) => {
      if (input.kind === "touch" && input.phase === "move") {
        const request = deferred<{ success: boolean }>();
        moveRequests.push({ leaseId, request });
        return request.promise;
      }
      return Promise.resolve({ success: true });
    });

    const { baseElement } = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const surface = slot<HTMLDivElement>(baseElement, "device-preview-surface");
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    inputSurface.setPointerCapture = vi.fn();
    surface.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 400,
        right: 300,
        bottom: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    let pointerNow = 0;
    const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => pointerNow);
    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 46,
      pointerType: "touch",
      clientX: 120,
      clientY: 250,
    });
    for (let index = 0; index < 20; index += 1) {
      pointerNow += 20;
      dispatchPointer(inputSurface, "pointermove", {
        pointerId: 46,
        pointerType: "touch",
        clientX: 110 + index * 5,
        clientY: 250,
      });
    }
    expect(moveRequests).toHaveLength(16);
    expect(moveRequests.every(({ leaseId }) => leaseId === "lease-ios-old")).toBe(true);

    await act(async () => {
      streamRequests[0]?.reject(new Error("stream disconnected"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute("data-stream-status", "error");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestDevicePreviewStream).toHaveBeenCalledTimes(2);
    expect(slot(baseElement, "device-preview-page")).toHaveAttribute(
      "data-stream-status",
      "streaming",
    );

    dispatchPointer(inputSurface, "pointerdown", {
      pointerId: 47,
      pointerType: "touch",
      clientX: 200,
      clientY: 430,
    });
    for (let index = 0; index < 20; index += 1) {
      pointerNow += 20;
      dispatchPointer(inputSurface, "pointermove", {
        pointerId: 47,
        pointerType: "touch",
        clientX: 200,
        clientY: 350,
      });
    }
    expect(moveRequests).toHaveLength(32);
    expect(moveRequests.slice(16).every(({ leaseId }) => leaseId === "lease-ios-new")).toBe(true);

    await act(async () => {
      moveRequests[0]?.request.resolve({ success: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    // A late completion from the old lease only updates its old window.
    expect(moveRequests).toHaveLength(32);

    await act(async () => {
      moveRequests[16]?.request.resolve({ success: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(moveRequests).toHaveLength(33);
    expect(moveRequests.at(-1)?.leaseId).toBe("lease-ios-new");

    dispatchPointer(inputSurface, "pointercancel", {
      pointerId: 47,
      pointerType: "touch",
      clientX: 200,
      clientY: 350,
    });
    await act(async () => {
      for (const { request } of moveRequests) request.resolve({ success: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    performanceNow.mockRestore();
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
    const inputSurface = slot<HTMLDivElement>(baseElement, "device-preview-input-surface");
    const chrome = slot<HTMLDivElement>(baseElement, "device-preview-device-chrome");
    inputSurface.setPointerCapture = vi.fn();
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

    dispatchPointer(chrome, "pointerdown", { pointerId: 9, clientX: 150, clientY: 150 });
    dispatchPointer(chrome, "pointerup", { pointerId: 9, clientX: 150, clientY: 150 });
    expect(sendDevicePreviewInput).not.toHaveBeenCalled();

    dispatchPointer(inputSurface, "pointerdown", { pointerId: 1, clientX: 10, clientY: 150 });
    dispatchPointer(inputSurface, "pointerup", { pointerId: 1, clientX: 10, clientY: 150 });
    expect(sendDevicePreviewInput).not.toHaveBeenCalled();

    dispatchPointer(inputSurface, "pointerdown", { pointerId: 2, clientX: 150, clientY: 150 });
    dispatchPointer(inputSurface, "pointerup", { pointerId: 2, clientX: 150, clientY: 150 });
    await waitFor(() => expect(sendDevicePreviewInput).toHaveBeenCalledTimes(2));
    expect(sendDevicePreviewInput.mock.calls).toEqual([
      ["lease-viewer", { kind: "touch", phase: "down", x: 0.5, y: 0.5 }],
      ["lease-viewer", { kind: "touch", phase: "up", x: 0.5, y: 0.5 }],
    ]);

    act(() => {
      messageHandler?.({
        type: "device_preview_control_revoked_push",
        scope: previewScope,
        leaseId: "lease-viewer",
        reason: "taken_over",
      });
    });
    expect(page).toHaveAttribute("data-control-mode", "view_only");
    expect(surface).toHaveAttribute("data-control-enabled", "false");
  });
});
