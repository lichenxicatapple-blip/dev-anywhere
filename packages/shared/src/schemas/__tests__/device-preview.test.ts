import { describe, expect, it } from "vitest";
import {
  DevicePreviewCapabilitySchema,
  DevicePreviewInputSchema,
  DevicePreviewNameSchema,
  DevicePreviewStreamFlowSchema,
  DevicePreviewStreamFormatSchema,
  DevicePreviewStreamProfileSchema,
  DevicePreviewStreamRegisterResponseSchema,
  DevicePreviewStreamStopReasonSchema,
  DevicePreviewStreamRegisterSchema,
  DevicePreviewSummarySchema,
  DevicePreviewTargetSchema,
  DevicePreviewToolStatusSchema,
} from "../device-preview.js";
import {
  isClientToProxyRelayControlType,
  isProxyToClientRelayControlType,
  RelayControlSchema,
} from "../relay-control.js";

const previewScope = { proxyId: "proxy-1", bindingId: "binding-1" } as const;
const readyDevicePreview = {
  previewId: "preview-ios",
  name: "iPhone",
  platform: "ios",
  targetId: "ios:simulator",
  model: "iPhone 17 Pro",
  osVersion: "26.4",
  state: "ready",
  interactive: true,
  createdAt: 1,
  updatedAt: 1,
} as const;

describe("device preview schemas", () => {
  it("models unsupported, unavailable, and ready tools as exclusive states", () => {
    const valid = [
      {
        supported: false,
        available: false,
        interactive: false,
        error: "iOS requires macOS",
      },
      {
        supported: true,
        available: false,
        interactive: false,
        command: "/opt/bin/baguette",
        version: "0.1.90",
        error: "Baguette is too old",
      },
      {
        supported: true,
        available: true,
        interactive: true,
        command: "/opt/android/platform-tools/adb",
        version: "Android Debug Bridge version 1.0.41",
      },
    ] as const;
    for (const status of valid) {
      expect(DevicePreviewToolStatusSchema.parse(status)).toEqual(status);
    }

    const invalid = [
      { supported: false, available: false, interactive: false },
      {
        supported: false,
        available: false,
        interactive: false,
        command: "baguette",
        error: "unsupported",
      },
      { supported: true, available: false, interactive: false },
      { supported: true, available: false, interactive: true, error: "missing" },
      { supported: true, available: true, interactive: true },
      {
        supported: true,
        available: true,
        interactive: false,
        command: "adb",
      },
      {
        supported: true,
        available: true,
        interactive: true,
        command: "adb",
        error: "mixed state",
      },
    ];
    for (const status of invalid) {
      expect(DevicePreviewToolStatusSchema.safeParse(status).success).toBe(false);
    }
  });

  it("strips capability and nested tool descriptions", () => {
    expect(
      DevicePreviewCapabilitySchema.parse({
        displayName: "Devices",
        ios: {
          supported: true,
          available: true,
          interactive: true,
          command: "baguette",
          displayName: "iOS",
        },
        android: {
          supported: true,
          available: true,
          interactive: true,
          command: "adb",
          displayName: "Android",
        },
      }),
    ).toEqual({
      ios: { supported: true, available: true, interactive: true, command: "baguette" },
      android: { supported: true, available: true, interactive: true, command: "adb" },
    });
  });

  it("requires one Preview scope on every management request", () => {
    const requests = [
      {
        type: "device_preview_capability_request",
        requestId: "capability-1",
        refreshPath: false,
      },
      { type: "device_preview_targets_request", requestId: "targets-1", refresh: true },
      {
        type: "device_preview_create_request",
        requestId: "create-1",
        operationId: "operation-1",
        targetId: "ios:simulator",
      },
      { type: "device_preview_list_request", requestId: "list-1" },
      {
        type: "device_preview_rename_request",
        requestId: "rename-1",
        operationId: "rename-operation-1",
        previewId: "preview-1",
        name: "Checkout",
      },
      {
        type: "device_preview_reconnect_request",
        requestId: "reconnect-1",
        operationId: "reconnect-operation-1",
        previewId: "preview-1",
      },
      {
        type: "device_preview_close_request",
        requestId: "close-1",
        operationId: "close-operation-1",
        previewId: "preview-1",
      },
    ] as const;

    for (const request of requests) {
      expect(RelayControlSchema.safeParse(request).success).toBe(false);
      expect(RelayControlSchema.parse({ ...request, scope: previewScope })).toEqual({
        ...request,
        scope: previewScope,
      });
    }
  });

  it("requires operationId on every rename, reconnect, and close request and response", () => {
    const messagesWithoutOperation = [
      {
        type: "device_preview_rename_request",
        requestId: "rename-1",
        scope: previewScope,
        previewId: "preview-1",
        name: "Checkout",
      },
      {
        type: "device_preview_rename_response",
        requestId: "rename-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "device_preview_reconnect_request",
        requestId: "reconnect-1",
        scope: previewScope,
        previewId: "preview-1",
      },
      {
        type: "device_preview_reconnect_response",
        requestId: "reconnect-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "device_preview_close_request",
        requestId: "close-1",
        scope: previewScope,
        previewId: "preview-1",
      },
      {
        type: "device_preview_close_response",
        requestId: "close-1",
        previewId: "preview-1",
        success: true,
      },
    ] as const;

    for (const message of messagesWithoutOperation) {
      expect(RelayControlSchema.safeParse(message).success).toBe(false);
    }
  });

  it("accepts a bounded target descriptor", () => {
    expect(
      DevicePreviewTargetSchema.parse({
        targetId: "ios:simulator",
        platform: "ios",
        name: "iPhone",
        model: "iPhone 17 Pro",
        osVersion: "26.4",
        width: 402,
        height: 874,
        interactive: true,
      }),
    ).toMatchObject({ targetId: "ios:simulator" });
    expect(
      DevicePreviewSummarySchema.parse({
        previewId: "preview-ios",
        name: "iPhone",
        platform: "ios",
        targetId: "ios:simulator",
        model: "iPhone 17 Pro",
        osVersion: "26.4",
        state: "ready",
        interactive: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toMatchObject({ previewId: "preview-ios" });
  });

  it("requires paired target dimensions while stripping descriptive extensions", () => {
    const target = {
      targetId: "ios:simulator",
      platform: "ios",
      name: "iPhone",
      model: "iPhone 17 Pro",
      osVersion: "26.4",
      interactive: true,
    } as const;

    expect(DevicePreviewTargetSchema.safeParse(target).success).toBe(true);
    expect(DevicePreviewTargetSchema.parse({ ...target, displayGroup: "Phone" })).toEqual(target);
    expect(
      DevicePreviewTargetSchema.safeParse({ ...target, width: 402, height: 874 }).success,
    ).toBe(true);
    for (const invalid of [
      { ...target, width: 402 },
      { ...target, height: 874 },
    ]) {
      expect(
        DevicePreviewTargetSchema.safeParse({ ...invalid, displayGroup: "Phone" }).success,
      ).toBe(false);
    }
  });

  it("keeps capture errors out of the persistent preview summary", () => {
    expect(
      DevicePreviewSummarySchema.parse({ ...readyDevicePreview, displayGroup: "Phone" }),
    ).toEqual(readyDevicePreview);
    expect(
      DevicePreviewSummarySchema.safeParse({
        ...readyDevicePreview,
        state: "disconnected",
      }).success,
    ).toBe(true);
    for (const preview of [
      { ...readyDevicePreview, error: "mixed state" },
      { ...readyDevicePreview, state: "disconnected", error: "mixed state" },
      { ...readyDevicePreview, state: "failed", error: "capture stopped" },
      { ...readyDevicePreview, state: "failed" },
    ]) {
      expect(DevicePreviewSummarySchema.safeParse(preview).success).toBe(false);
    }
  });

  it("requires device model and OS version metadata", () => {
    expect(
      DevicePreviewTargetSchema.safeParse({
        targetId: "ios:simulator",
        platform: "ios",
        name: "Simulator",
        interactive: true,
      }).success,
    ).toBe(false);
    expect(
      DevicePreviewSummarySchema.safeParse({
        previewId: "preview-ios",
        name: "Checkout flow",
        platform: "ios",
        targetId: "ios:simulator",
        state: "ready",
        interactive: true,
        createdAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects unnormalized input coordinates and oversized text", () => {
    expect(
      DevicePreviewInputSchema.safeParse({ kind: "touch", phase: "down", x: -0.01, y: 0.5 })
        .success,
    ).toBe(false);
    expect(
      DevicePreviewInputSchema.safeParse({ kind: "text", text: "x".repeat(4_097) }).success,
    ).toBe(false);
    expect(
      DevicePreviewInputSchema.parse({
        kind: "touch",
        phase: "down",
        x: 0.5,
        y: 0.99,
      }),
    ).toEqual({ kind: "touch", phase: "down", x: 0.5, y: 0.99 });
    expect(
      DevicePreviewInputSchema.safeParse({
        kind: "touch",
        phase: "cancel",
        x: 0.5,
        y: 0.5,
      }).success,
    ).toBe(false);
    expect(
      DevicePreviewInputSchema.safeParse({
        kind: "touch",
        phase: "up",
        x: 0.5,
        y: 0.5,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      DevicePreviewInputSchema.safeParse({
        kind: "touch",
        phase: "move",
        x: 0.5,
        y: 0.5,
        edge: "bottom",
      }).success,
    ).toBe(false);
  });

  it("preserves every phased touch field across validation", () => {
    const inputs = [
      { kind: "touch", phase: "down", x: 1, y: 0.5 },
      { kind: "touch", phase: "move", x: 0.6, y: 0.5 },
      { kind: "touch", phase: "up", x: 0.3, y: 0.5 },
    ] as const;

    expect(inputs.map((input) => DevicePreviewInputSchema.parse(input))).toEqual(inputs);
  });

  it("keeps the dedicated stream handshake outside RelayControl", () => {
    const register = {
      type: "device_preview_stream_register",
      proxyId: "proxy-1",
      connectionId: "connection-1",
    };
    expect(DevicePreviewStreamRegisterSchema.parse(register)).toEqual(register);
    expect(
      DevicePreviewStreamRegisterSchema.parse({ ...register, displayName: "Device stream" }),
    ).toEqual(register);
    expect(
      DevicePreviewStreamRegisterSchema.safeParse({
        ...register,
        connectionId: 1,
        displayName: "Device stream",
      }).success,
    ).toBe(false);
    expect(
      DevicePreviewStreamFlowSchema.safeParse({
        type: "device_preview_stream_flow",
        streamId: "stream-1",
        paused: true,
        resyncRequired: false,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      DevicePreviewStreamFlowSchema.safeParse({
        type: "device_preview_stream_flow",
        streamId: "stream-1",
        paused: true,
        resyncRequired: false,
      }).success,
    ).toBe(true);
    expect(
      DevicePreviewStreamFlowSchema.safeParse({
        type: "device_preview_stream_flow",
        streamId: "stream-1",
        paused: false,
        resyncRequired: true,
      }).success,
    ).toBe(true);
    for (const invalid of [
      {
        type: "device_preview_stream_flow",
        streamId: "stream-1",
        paused: true,
      },
      {
        type: "device_preview_stream_flow",
        streamId: "stream-1",
        paused: true,
        resyncRequired: true,
      },
      {
        type: "device_preview_stream_flow",
        streamId: "stream-1",
        paused: false,
      },
    ]) {
      expect(DevicePreviewStreamFlowSchema.safeParse(invalid).success).toBe(false);
    }
    expect(RelayControlSchema.safeParse(register).success).toBe(false);
    for (const result of [{ success: true }, { success: false, error: "registration failed" }]) {
      const response = { type: "device_preview_stream_register_response", ...result };
      expect(
        DevicePreviewStreamRegisterResponseSchema.parse({
          ...response,
          displayName: "Device stream",
        }),
      ).toEqual(response);
    }
    for (const invalid of [
      { type: "device_preview_stream_register_response", success: false },
      { type: "device_preview_stream_register_response", success: false, error: "" },
      {
        type: "device_preview_stream_register_response",
        success: true,
        error: "mixed",
      },
    ]) {
      expect(DevicePreviewStreamRegisterResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("round-trips management, streaming and input controls with strict directions", () => {
    const messages = [
      {
        type: "device_preview_create_request",
        requestId: "create-1",
        scope: previewScope,
        operationId: "operation-1",
        targetId: "emulator-5554",
        name: "Pixel checkout",
      },
      {
        type: "device_preview_rename_request",
        requestId: "rename-1",
        scope: previewScope,
        operationId: "rename-operation-1",
        previewId: "preview-1",
        name: "Pixel checkout",
      },
      {
        type: "device_preview_rename_response",
        requestId: "rename-1",
        scope: previewScope,
        operationId: "rename-operation-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "device_preview_stream_start",
        streamId: "stream-1",
        leaseId: "lease-1",
        previewId: "preview-1",
        format: "h264_annex_b",
      },
      {
        type: "device_preview_stream_start_response",
        streamId: "stream-1",
        leaseId: "lease-1",
        previewId: "preview-1",
        success: true,
        format: "h264_annex_b",
        width: 720,
        height: 1_280,
      },
      {
        type: "device_preview_input",
        scope: previewScope,
        leaseId: "lease-1",
        inputSeq: 4,
        input: { kind: "touch", phase: "down", x: 0.25, y: 0.75 },
      },
      {
        type: "device_preview_input",
        scope: previewScope,
        leaseId: "lease-1",
        inputSeq: 5,
        input: {
          kind: "touch",
          phase: "move",
          x: 0.5,
          y: 0.6,
        },
      },
      {
        type: "device_preview_control_revoked_push",
        scope: previewScope,
        leaseId: "lease-1",
        reason: "taken_over",
      },
    ] as const;

    for (const message of messages) {
      expect(RelayControlSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
    expect(isClientToProxyRelayControlType("device_preview_create_request")).toBe(true);
    expect(isClientToProxyRelayControlType("device_preview_rename_request")).toBe(true);
    expect(isProxyToClientRelayControlType("device_preview_rename_response")).toBe(true);
    expect(isClientToProxyRelayControlType("device_preview_input")).toBe(true);
    expect(isProxyToClientRelayControlType("device_preview_stream_start_response")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_stream_complete")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_input_ack")).toBe(true);
    expect(isClientToProxyRelayControlType("device_preview_stream_start")).toBe(false);
    expect(isClientToProxyRelayControlType("device_preview_stream_stop")).toBe(false);
    expect(isClientToProxyRelayControlType("device_preview_input_revoke")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_input_revoke")).toBe(false);
    expect(isClientToProxyRelayControlType("device_preview_stream_url_request")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_stream_url_request")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_stream_url_response")).toBe(false);
    expect(isClientToProxyRelayControlType("device_preview_stream_url_response")).toBe(false);
    expect(isClientToProxyRelayControlType("device_preview_control_claim_request")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_control_claim_request")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_control_claim_response")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_control_revoked_push")).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_control_revoked_push",
        leaseId: "lease-1",
        reason: "taken_over",
      }).success,
    ).toBe(false);
    expect(DevicePreviewStreamStopReasonSchema.parse("stream_error")).toBe("stream_error");
  });

  it("trims custom names and rejects blank or oversized names", () => {
    expect(DevicePreviewNameSchema.parse("  Pixel checkout  ")).toBe("Pixel checkout");

    for (const name of ["   ", "x".repeat(257)]) {
      expect(DevicePreviewNameSchema.safeParse(name).success).toBe(false);
      expect(
        RelayControlSchema.safeParse({
          type: "device_preview_create_request",
          requestId: "create-invalid-name",
          scope: previewScope,
          operationId: "create-invalid-name-operation",
          targetId: "emulator-5554",
          name,
        }).success,
      ).toBe(false);
      expect(
        RelayControlSchema.safeParse({
          type: "device_preview_rename_request",
          requestId: "rename-invalid-name",
          scope: previewScope,
          operationId: "rename-invalid-name-operation",
          previewId: "preview-1",
          name,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects invalid stream profiles and input sequence values", () => {
    expect(DevicePreviewStreamProfileSchema.parse({ format: "jpeg", maxFps: 15 })).toEqual({
      format: "jpeg",
      maxFps: 15,
    });
    expect(DevicePreviewStreamFormatSchema.parse("h264_annex_b")).toBe("h264_annex_b");
    expect(DevicePreviewStreamFormatSchema.safeParse("h265_annex_b").success).toBe(false);
    expect(DevicePreviewStreamProfileSchema.safeParse({ maxFps: 15 }).success).toBe(false);
    for (const profile of [
      { format: "jpeg", maxWidth: 720 },
      { format: "jpeg", jpegQuality: 70 },
      { format: "h264_annex_b", jpegQuality: 70 },
      { format: "h264_annex_b", maxFps: 30 },
      { format: "h264_annex_b", extra: true },
    ]) {
      expect(DevicePreviewStreamProfileSchema.safeParse(profile).success).toBe(false);
    }
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_stream_url_request",
        requestId: "stream-url-without-profile",
        scope: previewScope,
        previewId: "preview-1",
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_stream_start_response",
        streamId: "stream-1",
        leaseId: "lease-1",
        previewId: "preview-1",
        success: true,
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_stream_url_request",
        requestId: "stream-url-1",
        scope: previewScope,
        previewId: "preview-1",
        profile: { maxFps: 60 },
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_stream_start",
        streamId: "stream-1",
        leaseId: "lease-1",
        previewId: "preview-1",
        format: "h265_annex_b",
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_input",
        scope: previewScope,
        leaseId: "lease-1",
        inputSeq: 0x1_0000_0000,
        input: { kind: "button", button: "home" },
      }).success,
    ).toBe(false);
  });

  it("requires explicit refreshPath and a strict capability response state", () => {
    expect(
      RelayControlSchema.parse({
        type: "device_preview_capability_request",
        requestId: "capability-1",
        scope: previewScope,
        refreshPath: false,
      }),
    ).toMatchObject({ refreshPath: false, scope: previewScope });
    expect(
      RelayControlSchema.parse({
        type: "device_preview_capability_response",
        requestId: "capability-1",
        scope: previewScope,
        success: true,
        capability: {
          ios: { supported: true, available: true, interactive: true, command: "baguette" },
          android: { supported: true, available: true, interactive: true, command: "adb" },
        },
      }),
    ).toMatchObject({ success: true, capability: { ios: { supported: true } } });
    expect(
      RelayControlSchema.parse({
        type: "device_preview_capability_response",
        requestId: "capability-2",
        scope: previewScope,
        success: false,
        error: "detection failed",
        errorCode: "UNKNOWN",
      }),
    ).toMatchObject({ success: false, error: "detection failed", errorCode: "UNKNOWN" });

    for (const invalid of [
      {
        type: "device_preview_capability_request",
        requestId: "missing-refresh",
        scope: previewScope,
      },
      {
        type: "device_preview_capability_response",
        requestId: "missing-capability",
        success: true,
      },
      {
        type: "device_preview_capability_response",
        requestId: "missing-error",
        success: false,
      },
      {
        type: "device_preview_capability_response",
        requestId: "missing-error-code",
        scope: previewScope,
        success: false,
        error: "detection failed",
      },
      {
        type: "device_preview_capability_response",
        requestId: "illegal-mixed-state",
        success: true,
        error: "failed",
        capability: {
          ios: { supported: true, available: true, interactive: true, command: "baguette" },
          android: { supported: true, available: true, interactive: true, command: "adb" },
        },
      },
    ]) {
      expect(RelayControlSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires explicit target refresh and strict mutually exclusive Device responses", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_targets_request",
        requestId: "targets-1",
        scope: previewScope,
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_targets_request",
        requestId: "targets-1",
        scope: previewScope,
        refresh: false,
      }).success,
    ).toBe(true);

    const mutationBase = {
      requestId: "mutation-1",
      scope: previewScope,
      operationId: "operation-1",
      previewId: "preview-1",
    } as const;
    const valid = [
      {
        type: "device_preview_targets_response",
        requestId: "targets-1",
        scope: previewScope,
        success: true,
        targets: [],
      },
      {
        type: "device_preview_targets_response",
        requestId: "targets-1",
        scope: previewScope,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
      },
      { type: "device_preview_rename_response", ...mutationBase, success: true },
      {
        type: "device_preview_rename_response",
        ...mutationBase,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
      },
      { type: "device_preview_reconnect_response", ...mutationBase, success: true },
      {
        type: "device_preview_reconnect_response",
        ...mutationBase,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
      },
      { type: "device_preview_close_response", ...mutationBase, success: true },
      {
        type: "device_preview_close_response",
        ...mutationBase,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
      },
    ] as const;
    for (const message of valid) {
      expect(RelayControlSchema.parse({ ...message, displayHint: "Device" })).toEqual(message);
    }

    const invalid = [
      {
        type: "device_preview_targets_response",
        requestId: "targets-1",
        scope: previewScope,
        success: true,
      },
      {
        type: "device_preview_targets_response",
        requestId: "targets-1",
        scope: previewScope,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
        targets: [],
      },
      {
        type: "device_preview_targets_response",
        requestId: "targets-1",
        scope: previewScope,
        success: false,
        error: "failed",
      },
      { type: "device_preview_reconnect_response", ...mutationBase, success: false, error: "" },
      { type: "device_preview_close_response", ...mutationBase, success: false },
    ] as const;
    for (const message of invalid)
      expect(RelayControlSchema.safeParse({ ...message, displayHint: "Device" }).success).toBe(
        false,
      );
  });

  it("enforces strict stream, input, and control response states", () => {
    const streamIdentity = {
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId: "preview-1",
    } as const;
    const urlIdentity = {
      type: "device_preview_stream_url_response",
      requestId: "url-1",
      scope: previewScope,
      previewId: "preview-1",
    } as const;
    const inputIdentity = {
      type: "device_preview_input_ack",
      scope: previewScope,
      leaseId: "lease-1",
      inputSeq: 1,
    } as const;
    const claimIdentity = {
      type: "device_preview_control_claim_response",
      requestId: "claim-1",
      scope: previewScope,
      leaseId: "lease-1",
    } as const;
    const valid = [
      {
        ...urlIdentity,
        success: true,
        url: "/stream/token",
        leaseId: "lease-1",
        expiresAt: 1,
        controlMode: "controller",
      },
      { ...urlIdentity, success: false, error: "failed", errorCode: "UNKNOWN" },
      {
        type: "device_preview_stream_start_response",
        ...streamIdentity,
        success: true,
        format: "jpeg",
      },
      {
        type: "device_preview_stream_start_response",
        ...streamIdentity,
        success: true,
        format: "h264_annex_b",
        width: 720,
        height: 1_280,
      },
      {
        type: "device_preview_stream_start_response",
        ...streamIdentity,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
      },
      {
        type: "device_preview_stream_complete",
        ...streamIdentity,
        success: false,
        error: "failed",
      },
      { ...inputIdentity, success: true },
      { ...inputIdentity, success: false, error: "failed", errorCode: "UNKNOWN" },
      { ...claimIdentity, success: true, controlMode: "controller" },
      { ...claimIdentity, success: false, error: "failed", errorCode: "UNKNOWN" },
    ] as const;
    for (const message of valid) {
      expect(RelayControlSchema.parse({ ...message, displayHint: "Stream" })).toEqual(message);
    }

    const invalid = [
      { ...urlIdentity, success: true, url: "/stream/token", leaseId: "lease-1" },
      {
        ...urlIdentity,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
        url: "/legacy",
      },
      { ...urlIdentity, success: false, error: "failed" },
      {
        type: "device_preview_stream_start_response",
        ...streamIdentity,
        success: true,
      },
      {
        type: "device_preview_stream_start_response",
        ...streamIdentity,
        success: true,
        format: "jpeg",
        width: 720,
      },
      {
        type: "device_preview_stream_start_response",
        ...streamIdentity,
        success: true,
        format: "jpeg",
        height: 1_280,
      },
      {
        type: "device_preview_stream_start_response",
        ...streamIdentity,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
        format: "jpeg",
      },
      {
        type: "device_preview_stream_start_response",
        ...streamIdentity,
        success: false,
        error: "failed",
      },
      { type: "device_preview_stream_complete", ...streamIdentity, success: true },
      { ...inputIdentity, success: false, error: "", errorCode: "UNKNOWN" },
      { ...inputIdentity, success: false, error: "failed" },
      { ...claimIdentity, success: true, controlMode: "view_only" },
      {
        ...claimIdentity,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
        controlMode: "view_only",
      },
      { ...claimIdentity, success: false, error: "failed" },
    ] as const;
    for (const message of invalid)
      expect(RelayControlSchema.safeParse({ ...message, displayHint: "Stream" }).success).toBe(
        false,
      );
  });

  it("limits authoritative Device Preview states to persisted outcomes", () => {
    for (const state of ["starting", "stopping"]) {
      expect(DevicePreviewSummarySchema.safeParse({ ...readyDevicePreview, state }).success).toBe(
        false,
      );
    }
  });

  it("keeps scoped Device Preview requests strict but accepts response and push descriptions", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_list_request",
        requestId: "list-1",
        scope: previewScope,
        extra: true,
      }).success,
    ).toBe(false);
    const messages = [
      {
        type: "device_preview_list_response",
        requestId: "list-1",
        scope: previewScope,
        epoch: "epoch-1",
        revision: 0,
        previews: [],
      },
      {
        type: "device_preview_state_event",
        epoch: "epoch-1",
        revision: 1,
        preview: readyDevicePreview,
      },
      {
        type: "device_preview_state_push",
        scope: previewScope,
        epoch: "epoch-1",
        revision: 1,
        preview: readyDevicePreview,
      },
    ] as const;
    for (const message of messages) {
      expect(
        RelayControlSchema.parse({
          ...message,
          displayHint: "Device",
          ...("preview" in message
            ? { preview: { ...message.preview, displayHint: "Phone" } }
            : {}),
        }),
      ).toEqual(message);
    }
  });

  it("rejects illegal Device Preview create ACK states", () => {
    const base = {
      type: "device_preview_create_response",
      requestId: "create-1",
      scope: previewScope,
      operationId: "operation-1",
    } as const;
    for (const message of [
      { ...base, accepted: true },
      {
        ...base,
        accepted: false,
        error: "failed",
        errorCode: "UNKNOWN",
        previewId: "preview-1",
      },
      { ...base, accepted: false },
      { ...base, accepted: false, error: "failed" },
    ]) {
      expect(RelayControlSchema.safeParse(message).success).toBe(false);
    }
    expect(
      RelayControlSchema.safeParse({
        ...base,
        accepted: false,
        error: "failed",
        errorCode: "UNKNOWN",
      }).success,
    ).toBe(true);
  });

  it("requires scope on every browser-facing Device data and push message", () => {
    const state = {
      epoch: "device-epoch-1",
      revision: 1,
      preview: readyDevicePreview,
    };
    expect(
      RelayControlSchema.safeParse({ type: "device_preview_state_push", ...state }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_state_push",
        scope: previewScope,
        ...state,
      }).success,
    ).toBe(true);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_stream_url_request",
        requestId: "url-1",
        previewId: "preview-1",
        profile: { format: "jpeg" },
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_input",
        leaseId: "lease-1",
        inputSeq: 1,
        input: { kind: "button", button: "home" },
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_control_claim_request",
        requestId: "claim-1",
        leaseId: "lease-1",
      }).success,
    ).toBe(false);
  });

  it("separates Device Proxy events from Relay-scoped browser pushes", () => {
    const event = {
      type: "device_preview_state_event",
      epoch: "device-epoch-1",
      revision: 1,
      preview: readyDevicePreview,
    } as const;
    expect(RelayControlSchema.parse(event)).toEqual(event);
    expect(isProxyToClientRelayControlType("device_preview_state_event")).toBe(false);
    expect(isClientToProxyRelayControlType("device_preview_state_event")).toBe(false);
    expect(isProxyToClientRelayControlType("device_preview_state_push")).toBe(true);
  });
});
