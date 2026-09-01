import { describe, expect, it, vi } from "vitest";
import { RelayControlSchema } from "@dev-anywhere/shared";
import type { DevicePreviewManager } from "#src/serve/device-preview/device-preview-manager.js";
import { RelayDevicePreviewHandlers } from "#src/serve/device-preview/relay-device-preview-handlers.js";

function harness(overrides: Partial<Record<keyof DevicePreviewManager, unknown>> = {}) {
  const sent: unknown[] = [];
  const manager = {
    inspectCapabilities: vi.fn(async () => ({
      supported: true,
      ios: { supported: true, available: false, interactive: false, error: "missing" },
      android: { supported: true, available: true, interactive: true, command: "adb" },
    })),
    discoverTargets: vi.fn(async () => []),
    create: vi.fn(async () => ({ previewId: "preview-1" })),
    list: vi.fn(() => ({ epoch: "epoch-1", revision: 1, previews: [] })),
    reconnect: vi.fn(async () => undefined),
    close: vi.fn(),
    startStream: vi.fn(async () => ({
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId: "preview-1",
      width: 720,
      height: 1600,
    })),
    stopStream: vi.fn(),
    revokeInput: vi.fn(),
    sendInput: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as DevicePreviewManager;
  return {
    manager,
    sent,
    handlers: new RelayDevicePreviewHandlers({
      manager,
      relaySend: (raw) => sent.push(RelayControlSchema.parse(JSON.parse(raw))),
    }),
  };
}

describe("RelayDevicePreviewHandlers", () => {
  it("serializes capability, targets, create, and list responses through the shared schema", async () => {
    const { handlers, sent } = harness();

    await handlers.onCapability({
      type: "device_preview_capability_request",
      requestId: "cap-1",
      refreshPath: true,
    });
    await handlers.onTargets({
      type: "device_preview_targets_request",
      requestId: "targets-1",
      refresh: true,
    });
    await handlers.onCreate({
      type: "device_preview_create_request",
      requestId: "create-1",
      operationId: "operation-1",
      targetId: "android:emulator-5554",
    });
    handlers.onList({ type: "device_preview_list_request", requestId: "list-1" });

    expect(sent).toMatchObject([
      { type: "device_preview_capability_response", requestId: "cap-1" },
      {
        type: "device_preview_targets_response",
        requestId: "targets-1",
        success: true,
        targets: [],
      },
      {
        type: "device_preview_create_response",
        requestId: "create-1",
        accepted: true,
        previewId: "preview-1",
      },
      {
        type: "device_preview_list_response",
        requestId: "list-1",
        epoch: "epoch-1",
      },
    ]);
  });

  it("ACKs stream starts and input only after manager acceptance", async () => {
    const { handlers, manager, sent } = harness();
    await handlers.onStreamStart({
      type: "device_preview_stream_start",
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId: "preview-1",
      maxFps: 15,
    });
    await handlers.onInput({
      type: "device_preview_input",
      leaseId: "lease-1",
      inputSeq: 9,
      input: { kind: "tap", x: 0.25, y: 0.75 },
    });

    expect(manager.sendInput).toHaveBeenCalledWith("lease-1", 9, {
      kind: "tap",
      x: 0.25,
      y: 0.75,
    });
    expect(sent).toMatchObject([
      {
        type: "device_preview_stream_start_response",
        streamId: "stream-1",
        success: true,
      },
      {
        type: "device_preview_input_ack",
        leaseId: "lease-1",
        inputSeq: 9,
        success: true,
      },
    ]);
  });

  it("routes Relay-owned input revocation without stopping the viewer", () => {
    const { handlers, manager } = harness();

    handlers.onInputRevoke({
      type: "device_preview_input_revoke",
      leaseId: "lease-1",
      reason: "control_taken_over",
    });

    expect(manager.revokeInput).toHaveBeenCalledWith("lease-1");
    expect(manager.stopStream).not.toHaveBeenCalled();
  });

  it("returns bounded protocol failures instead of leaking rejected promises", async () => {
    const { handlers, sent } = harness({
      startStream: vi.fn(async () => {
        throw new Error("stream unavailable");
      }),
      sendInput: vi.fn(async () => {
        throw new Error("lease expired");
      }),
    });

    await handlers.onStreamStart({
      type: "device_preview_stream_start",
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId: "preview-1",
    });
    await handlers.onInput({
      type: "device_preview_input",
      leaseId: "lease-1",
      inputSeq: 1,
      input: { kind: "button", button: "home" },
    });

    expect(sent).toMatchObject([
      { type: "device_preview_stream_start_response", success: false, error: "stream unavailable" },
      { type: "device_preview_input_ack", success: false, error: "lease expired" },
    ]);
  });
});
