import { describe, expect, it, vi } from "vitest";
import { ControlErrorCode, RelayControlSchema } from "@dev-anywhere/shared";
import {
  DevicePreviewOperationError,
  type DevicePreviewManager,
} from "#src/serve/device-preview/device-preview-manager.js";
import { RelayDevicePreviewHandlers } from "#src/serve/device-preview/relay-device-preview-handlers.js";
import { PreviewOperationJournal } from "#src/serve/preview/preview-operation-journal.js";

const previewScope = { proxyId: "proxy-1", bindingId: "binding-1" } as const;

function harness(overrides: Partial<Record<keyof DevicePreviewManager, unknown>> = {}) {
  const sent: unknown[] = [];
  const manager = {
    inspectCapabilities: vi.fn(async () => ({
      ios: { supported: true, available: false, interactive: false, error: "missing" },
      android: { supported: true, available: true, interactive: true, command: "adb" },
    })),
    discoverTargets: vi.fn(async () => []),
    create: vi.fn(async () => ({ previewId: "preview-1" })),
    rename: vi.fn(() => ({ previewId: "preview-1", name: "QA phone" })),
    list: vi.fn(() => ({ epoch: "epoch-1", revision: 1, previews: [] })),
    reconnect: vi.fn(async () => undefined),
    close: vi.fn(),
    startStream: vi.fn(async () => ({
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId: "preview-1",
      format: "jpeg",
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
      operationJournal: new PreviewOperationJournal(),
    }),
  };
}

describe("RelayDevicePreviewHandlers", () => {
  it("serializes capability, targets, create, and list responses through the shared schema", async () => {
    const { handlers, manager, sent } = harness();

    await handlers.onCapability({
      type: "device_preview_capability_request",
      requestId: "cap-1",
      scope: previewScope,
      refreshPath: true,
    });
    await handlers.onTargets({
      type: "device_preview_targets_request",
      requestId: "targets-1",
      scope: previewScope,
      refresh: true,
    });
    await handlers.onCreate({
      type: "device_preview_create_request",
      requestId: "create-1",
      scope: previewScope,
      operationId: "operation-1",
      targetId: "android:emulator-5554",
      name: "QA phone",
    });
    handlers.onList({
      type: "device_preview_list_request",
      requestId: "list-1",
      scope: previewScope,
    });

    expect(sent).toMatchObject([
      { type: "device_preview_capability_response", requestId: "cap-1", success: true },
      {
        type: "device_preview_targets_response",
        requestId: "targets-1",
        success: true,
        targets: [],
      },
      {
        type: "device_preview_create_response",
        requestId: "create-1",
        operationId: "operation-1",
        accepted: true,
        previewId: "preview-1",
      },
      {
        type: "device_preview_list_response",
        requestId: "list-1",
        epoch: "epoch-1",
      },
    ]);
    expect(manager.create).toHaveBeenCalledWith("android:emulator-5554", "QA phone");
  });

  it("returns a strict failed capability response", async () => {
    const { handlers, sent } = harness({
      inspectCapabilities: vi.fn(async () => {
        throw new Error("device detection failed");
      }),
    });

    await handlers.onCapability({
      type: "device_preview_capability_request",
      requestId: "cap-failed",
      scope: previewScope,
      refreshPath: false,
    });

    expect(sent).toContainEqual({
      type: "device_preview_capability_response",
      requestId: "cap-failed",
      scope: previewScope,
      success: false,
      error: "device detection failed",
      errorCode: "UNKNOWN",
    });
  });

  it("routes device preview rename without echoing authoritative entity state", async () => {
    const { handlers, manager, sent } = harness();

    await handlers.onRename({
      type: "device_preview_rename_request",
      requestId: "rename-1",
      scope: previewScope,
      operationId: "rename-operation-1",
      previewId: "preview-1",
      name: "QA phone",
    });

    expect(manager.rename).toHaveBeenCalledWith("preview-1", "QA phone");
    expect(sent).toContainEqual({
      type: "device_preview_rename_response",
      requestId: "rename-1",
      scope: previewScope,
      operationId: "rename-operation-1",
      previewId: "preview-1",
      success: true,
    });
  });

  it("echoes operationId for reconnect and close acknowledgements", async () => {
    const { handlers, sent } = harness();

    await handlers.onReconnect({
      type: "device_preview_reconnect_request",
      requestId: "reconnect-1",
      scope: previewScope,
      operationId: "reconnect-operation-1",
      previewId: "preview-1",
    });
    await handlers.onClose({
      type: "device_preview_close_request",
      requestId: "close-1",
      scope: previewScope,
      operationId: "close-operation-1",
      previewId: "preview-1",
    });

    expect(sent).toContainEqual({
      type: "device_preview_reconnect_response",
      requestId: "reconnect-1",
      scope: previewScope,
      operationId: "reconnect-operation-1",
      previewId: "preview-1",
      success: true,
    });
    expect(sent).toContainEqual({
      type: "device_preview_close_response",
      requestId: "close-1",
      scope: previewScope,
      operationId: "close-operation-1",
      previewId: "preview-1",
      success: true,
    });
  });

  it("ACKs stream starts and input only after manager acceptance", async () => {
    const { handlers, manager, sent } = harness();
    await handlers.onStreamStart({
      type: "device_preview_stream_start",
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId: "preview-1",
      format: "jpeg",
      maxFps: 15,
    });
    await handlers.onInput({
      type: "device_preview_input",
      scope: previewScope,
      leaseId: "lease-1",
      inputSeq: 9,
      input: { kind: "button", button: "home" },
    });

    expect(manager.sendInput).toHaveBeenCalledWith("lease-1", 9, {
      kind: "button",
      button: "home",
    });
    expect(sent).toMatchObject([
      {
        type: "device_preview_stream_start_response",
        streamId: "stream-1",
        success: true,
        format: "jpeg",
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
        throw new DevicePreviewOperationError(
          "stream unavailable",
          ControlErrorCode.STREAM_CAPACITY_EXCEEDED,
        );
      }),
      sendInput: vi.fn(async () => {
        throw new DevicePreviewOperationError(
          "lease expired",
          ControlErrorCode.CONTROL_LEASE_INVALID,
        );
      }),
    });

    await handlers.onStreamStart({
      type: "device_preview_stream_start",
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId: "preview-1",
      format: "jpeg",
    });
    await handlers.onInput({
      type: "device_preview_input",
      scope: previewScope,
      leaseId: "lease-1",
      inputSeq: 1,
      input: { kind: "button", button: "home" },
    });

    expect(sent).toMatchObject([
      {
        type: "device_preview_stream_start_response",
        success: false,
        error: "stream unavailable",
        errorCode: "STREAM_CAPACITY_EXCEEDED",
      },
      {
        type: "device_preview_input_ack",
        success: false,
        error: "lease expired",
        errorCode: "CONTROL_LEASE_INVALID",
      },
    ]);
  });
});
