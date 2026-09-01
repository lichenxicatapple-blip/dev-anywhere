import { z } from "zod";
import { IdSchema } from "./id.js";
import { PreviewStateSchema } from "./web-preview.js";

const DEVICE_PREVIEW_PATH_MAX_LENGTH = 4_096;
const DEVICE_PREVIEW_TEXT_MAX_LENGTH = 4_096;
const DEVICE_PREVIEW_ERROR_MAX_LENGTH = 4_096;
const DEVICE_PREVIEW_NAME_MAX_LENGTH = 256;
const DEVICE_PREVIEW_VERSION_MAX_LENGTH = 256;
const DEVICE_PREVIEW_SCREEN_EDGE_MAX = 16_384;
const DEVICE_PREVIEW_STREAM_MAX_WIDTH = 4_096;

export const devicePreviewPlatformValues = ["ios", "android"] as const;
export const DevicePreviewPlatformSchema = z.enum(devicePreviewPlatformValues);
export type DevicePreviewPlatform = z.infer<typeof DevicePreviewPlatformSchema>;

export const DevicePreviewToolStatusSchema = z.object({
  supported: z.boolean(),
  available: z.boolean(),
  interactive: z.boolean(),
  command: z.string().min(1).max(DEVICE_PREVIEW_PATH_MAX_LENGTH).optional(),
  version: z.string().min(1).max(DEVICE_PREVIEW_VERSION_MAX_LENGTH).optional(),
  error: z.string().min(1).max(DEVICE_PREVIEW_ERROR_MAX_LENGTH).optional(),
  suggestions: z.array(z.string().min(1).max(DEVICE_PREVIEW_PATH_MAX_LENGTH)).max(32).optional(),
});
export type DevicePreviewToolStatus = z.infer<typeof DevicePreviewToolStatusSchema>;

export const DevicePreviewCapabilitySchema = z.object({
  supported: z.boolean(),
  ios: DevicePreviewToolStatusSchema,
  android: DevicePreviewToolStatusSchema,
});
export type DevicePreviewCapability = z.infer<typeof DevicePreviewCapabilitySchema>;

export const DevicePreviewTargetSchema = z.object({
  targetId: IdSchema,
  platform: DevicePreviewPlatformSchema,
  name: z.string().min(1).max(DEVICE_PREVIEW_NAME_MAX_LENGTH),
  osVersion: z.string().min(1).max(DEVICE_PREVIEW_VERSION_MAX_LENGTH).optional(),
  runtime: z.string().min(1).max(DEVICE_PREVIEW_VERSION_MAX_LENGTH).optional(),
  width: z.number().int().positive().max(DEVICE_PREVIEW_SCREEN_EDGE_MAX).optional(),
  height: z.number().int().positive().max(DEVICE_PREVIEW_SCREEN_EDGE_MAX).optional(),
  state: z.enum(["booted", "shutdown", "transitioning", "offline"]),
  interactive: z.boolean(),
});
export type DevicePreviewTarget = z.infer<typeof DevicePreviewTargetSchema>;

export const DevicePreviewSummarySchema = z.object({
  previewId: IdSchema,
  name: z.string().min(1).max(DEVICE_PREVIEW_NAME_MAX_LENGTH),
  platform: DevicePreviewPlatformSchema,
  targetId: IdSchema,
  targetName: z.string().min(1).max(DEVICE_PREVIEW_NAME_MAX_LENGTH),
  state: PreviewStateSchema,
  interactive: z.boolean(),
  error: z.string().min(1).max(DEVICE_PREVIEW_ERROR_MAX_LENGTH).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DevicePreviewSummary = z.infer<typeof DevicePreviewSummarySchema>;

export const DevicePreviewStreamProfileSchema = z.object({
  maxFps: z.number().int().min(1).max(30).optional(),
  maxWidth: z.number().int().min(320).max(DEVICE_PREVIEW_STREAM_MAX_WIDTH).optional(),
  jpegQuality: z.number().int().min(30).max(95).optional(),
});
export type DevicePreviewStreamProfile = z.infer<typeof DevicePreviewStreamProfileSchema>;

export const devicePreviewStreamStopReasonValues = [
  "client_closed",
  "token_revoked",
  "preview_closed",
  "proxy_offline",
  "relay_shutdown",
  "stream_error",
] as const;
export const DevicePreviewStreamStopReasonSchema = z.enum(devicePreviewStreamStopReasonValues);
export type DevicePreviewStreamStopReason = z.infer<typeof DevicePreviewStreamStopReasonSchema>;

const NormalizedCoordinateSchema = z.number().finite().min(0).max(1);
const DevicePreviewGestureDurationSchema = z.number().int().min(16).max(5_000);

export const devicePreviewOrientationValues = [
  "portrait",
  "landscape_left",
  "landscape_right",
  "portrait_upside_down",
  "auto",
] as const;
export const DevicePreviewOrientationSchema = z.enum(devicePreviewOrientationValues);
export type DevicePreviewOrientation = z.infer<typeof DevicePreviewOrientationSchema>;

// Browser coordinates are normalized. Only the Proxy adapter may turn them into device pixels or
// iOS points; this keeps stale frame dimensions and rotated screens out of the wire contract.
export const DevicePreviewInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tap"),
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
  }),
  z.object({
    kind: z.literal("swipe"),
    startX: NormalizedCoordinateSchema,
    startY: NormalizedCoordinateSchema,
    endX: NormalizedCoordinateSchema,
    endY: NormalizedCoordinateSchema,
    durationMs: DevicePreviewGestureDurationSchema,
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1).max(DEVICE_PREVIEW_TEXT_MAX_LENGTH),
  }),
  z.object({
    kind: z.literal("button"),
    button: z.enum(["home", "back"]),
  }),
  z.object({
    kind: z.literal("orientation"),
    orientation: DevicePreviewOrientationSchema,
  }),
]);
export type DevicePreviewInput = z.infer<typeof DevicePreviewInputSchema>;

// `/proxy-stream` is a dedicated, authenticated image data channel. Its small JSON handshake and
// flow-control messages deliberately stay outside RelayControlSchema: they must never be accepted
// on the main `/proxy` or `/client` sockets.
export const DevicePreviewStreamRegisterSchema = z.object({
  type: z.literal("device_preview_stream_register"),
  proxyId: IdSchema,
  connectionId: IdSchema,
});
export type DevicePreviewStreamRegister = z.infer<typeof DevicePreviewStreamRegisterSchema>;

export const DevicePreviewStreamRegisterResponseSchema = z.object({
  type: z.literal("device_preview_stream_register_response"),
  success: z.boolean(),
  error: z.string().min(1).max(DEVICE_PREVIEW_ERROR_MAX_LENGTH).optional(),
});
export type DevicePreviewStreamRegisterResponse = z.infer<
  typeof DevicePreviewStreamRegisterResponseSchema
>;

export const DevicePreviewStreamFlowSchema = z.object({
  type: z.literal("device_preview_stream_flow"),
  streamId: IdSchema,
  paused: z.boolean(),
});
export type DevicePreviewStreamFlow = z.infer<typeof DevicePreviewStreamFlowSchema>;

export const DevicePreviewStreamServerMessageSchema = z.discriminatedUnion("type", [
  DevicePreviewStreamRegisterResponseSchema,
  DevicePreviewStreamFlowSchema,
]);
export type DevicePreviewStreamServerMessage = z.infer<
  typeof DevicePreviewStreamServerMessageSchema
>;
