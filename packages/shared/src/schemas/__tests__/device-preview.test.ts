import { describe, expect, it } from "vitest";
import {
  DevicePreviewInputSchema,
  DevicePreviewStreamStopReasonSchema,
  DevicePreviewStreamRegisterSchema,
  DevicePreviewTargetSchema,
} from "../device-preview.js";
import {
  isClientToProxyRelayControlType,
  isProxyToClientRelayControlType,
  RelayControlSchema,
} from "../relay-control.js";

describe("device preview schemas", () => {
  it("accepts a bounded target descriptor", () => {
    expect(
      DevicePreviewTargetSchema.parse({
        targetId: "emulator-5554",
        platform: "android",
        name: "Pixel 9",
        osVersion: "16",
        width: 1080,
        height: 2424,
        state: "booted",
        interactive: true,
      }),
    ).toMatchObject({ targetId: "emulator-5554", state: "booted" });
  });

  it("rejects unnormalized input coordinates and oversized text", () => {
    expect(DevicePreviewInputSchema.safeParse({ kind: "tap", x: -0.01, y: 0.5 }).success).toBe(
      false,
    );
    expect(
      DevicePreviewInputSchema.safeParse({ kind: "text", text: "x".repeat(4_097) }).success,
    ).toBe(false);
    expect(
      DevicePreviewInputSchema.parse({
        kind: "swipe",
        startX: 0,
        startY: 1,
        endX: 1,
        endY: 0,
        durationMs: 300,
      }),
    ).toMatchObject({ kind: "swipe", durationMs: 300 });
  });

  it("keeps the dedicated stream handshake outside RelayControl", () => {
    const register = {
      type: "device_preview_stream_register",
      proxyId: "proxy-1",
      connectionId: "connection-1",
    };
    expect(DevicePreviewStreamRegisterSchema.parse(register)).toEqual(register);
    expect(RelayControlSchema.safeParse(register).success).toBe(false);
  });

  it("round-trips management, streaming and input controls with strict directions", () => {
    const messages = [
      {
        type: "device_preview_create_request",
        requestId: "create-1",
        operationId: "operation-1",
        targetId: "emulator-5554",
      },
      {
        type: "device_preview_stream_start",
        streamId: "stream-1",
        leaseId: "lease-1",
        previewId: "preview-1",
        maxFps: 10,
        maxWidth: 1280,
        jpegQuality: 70,
      },
      {
        type: "device_preview_input",
        leaseId: "lease-1",
        inputSeq: 4,
        input: { kind: "tap", x: 0.25, y: 0.75 },
      },
    ] as const;

    for (const message of messages) {
      expect(RelayControlSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
    expect(isClientToProxyRelayControlType("device_preview_create_request")).toBe(true);
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
    expect(DevicePreviewStreamStopReasonSchema.parse("stream_error")).toBe("stream_error");
  });

  it("rejects invalid stream profiles and input sequence values", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_stream_url_request",
        requestId: "stream-url-1",
        previewId: "preview-1",
        profile: { maxFps: 60 },
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "device_preview_input",
        leaseId: "lease-1",
        inputSeq: 0x1_0000_0000,
        input: { kind: "button", button: "home" },
      }).success,
    ).toBe(false);
  });

  it("accepts device preview capability on proxy_info without requiring it", () => {
    const base = {
      type: "proxy_info",
      requestId: "proxy-info-1",
      homePath: "/Users/dev",
      agentCli: {
        claude: { available: true },
        codex: { available: true },
      },
    };
    expect(RelayControlSchema.safeParse(base).success).toBe(true);
    expect(
      RelayControlSchema.parse({
        ...base,
        devicePreview: {
          supported: true,
          ios: { supported: true, available: true, interactive: true },
          android: { supported: true, available: true, interactive: true },
        },
      }),
    ).toMatchObject({ devicePreview: { supported: true } });
  });
});
