import { z } from "zod";
import { IdSchema } from "./id.js";

const DEVICE_PREVIEW_PATH_MAX_LENGTH = 4_096;
const DEVICE_PREVIEW_TEXT_MAX_LENGTH = 4_096;
const DEVICE_PREVIEW_ERROR_MAX_LENGTH = 4_096;
const DEVICE_PREVIEW_NAME_MAX_LENGTH = 256;
const DEVICE_PREVIEW_VERSION_MAX_LENGTH = 256;
const DEVICE_PREVIEW_SCREEN_EDGE_MAX = 16_384;

export const DevicePreviewNameSchema = z.string().trim().min(1).max(DEVICE_PREVIEW_NAME_MAX_LENGTH);

export const devicePreviewStreamFormatValues = ["jpeg", "h264_annex_b"] as const;
export const DevicePreviewStreamFormatSchema = z.enum(devicePreviewStreamFormatValues);
export type DevicePreviewStreamFormat = z.infer<typeof DevicePreviewStreamFormatSchema>;

export const devicePreviewPlatformValues = ["ios", "android"] as const;
export const DevicePreviewPlatformSchema = z.enum(devicePreviewPlatformValues);
export type DevicePreviewPlatform = z.infer<typeof DevicePreviewPlatformSchema>;

const DevicePreviewToolSuggestionsSchema = z
  .array(z.string().min(1).max(DEVICE_PREVIEW_PATH_MAX_LENGTH))
  .max(32)
  .optional();

export const DevicePreviewToolStatusSchema = z.union([
  z.object({
    supported: z.literal(false),
    available: z.literal(false),
    interactive: z.literal(false),
    command: z.never().optional(),
    version: z.never().optional(),
    error: z.string().min(1).max(DEVICE_PREVIEW_ERROR_MAX_LENGTH),
    suggestions: DevicePreviewToolSuggestionsSchema,
  }),
  z.object({
    supported: z.literal(true),
    available: z.literal(false),
    interactive: z.literal(false),
    command: z.string().min(1).max(DEVICE_PREVIEW_PATH_MAX_LENGTH).optional(),
    version: z.string().min(1).max(DEVICE_PREVIEW_VERSION_MAX_LENGTH).optional(),
    error: z.string().min(1).max(DEVICE_PREVIEW_ERROR_MAX_LENGTH),
    suggestions: DevicePreviewToolSuggestionsSchema,
  }),
  z.object({
    supported: z.literal(true),
    available: z.literal(true),
    interactive: z.literal(true),
    command: z.string().min(1).max(DEVICE_PREVIEW_PATH_MAX_LENGTH),
    version: z.string().min(1).max(DEVICE_PREVIEW_VERSION_MAX_LENGTH).optional(),
    error: z.never().optional(),
    suggestions: DevicePreviewToolSuggestionsSchema,
  }),
]);
export type DevicePreviewToolStatus = z.infer<typeof DevicePreviewToolStatusSchema>;

export const DevicePreviewCapabilitySchema = z.object({
  ios: DevicePreviewToolStatusSchema,
  android: DevicePreviewToolStatusSchema,
});
export type DevicePreviewCapability = z.infer<typeof DevicePreviewCapabilitySchema>;

const DevicePreviewTargetBaseSchema = z.object({
  targetId: IdSchema,
  platform: DevicePreviewPlatformSchema,
  name: z.string().min(1).max(DEVICE_PREVIEW_NAME_MAX_LENGTH),
  model: z.string().min(1).max(DEVICE_PREVIEW_NAME_MAX_LENGTH),
  osVersion: z.string().min(1).max(DEVICE_PREVIEW_VERSION_MAX_LENGTH),
  interactive: z.boolean(),
});

const DevicePreviewScreenEdgeSchema = z
  .number()
  .int()
  .positive()
  .max(DEVICE_PREVIEW_SCREEN_EDGE_MAX);

export const DevicePreviewTargetSchema = z.union([
  DevicePreviewTargetBaseSchema.extend({
    width: DevicePreviewScreenEdgeSchema,
    height: DevicePreviewScreenEdgeSchema,
  }),
  DevicePreviewTargetBaseSchema.extend({
    width: z.never().optional(),
    height: z.never().optional(),
  }),
]);
export type DevicePreviewTarget = z.infer<typeof DevicePreviewTargetSchema>;

export const DevicePreviewStateSchema = z.enum(["ready", "disconnected"]);
export type DevicePreviewState = z.infer<typeof DevicePreviewStateSchema>;

const DevicePreviewSummaryBaseSchema = z.object({
  previewId: IdSchema,
  name: DevicePreviewNameSchema,
  platform: DevicePreviewPlatformSchema,
  targetId: IdSchema,
  model: z.string().min(1).max(DEVICE_PREVIEW_NAME_MAX_LENGTH),
  osVersion: z.string().min(1).max(DEVICE_PREVIEW_VERSION_MAX_LENGTH),
  interactive: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const DevicePreviewSummarySchema = z.discriminatedUnion("state", [
  DevicePreviewSummaryBaseSchema.extend({
    state: z.literal("ready"),
    error: z.never().optional(),
  }),
  DevicePreviewSummaryBaseSchema.extend({
    state: z.literal("disconnected"),
    error: z.never().optional(),
  }),
]);
export type DevicePreviewSummary = z.infer<typeof DevicePreviewSummarySchema>;

export const DevicePreviewJpegStreamProfileSchema = z
  .object({
    format: z.literal("jpeg"),
    maxFps: z.number().int().min(1).max(30).optional(),
  })
  .strict();

export const DevicePreviewH264StreamProfileSchema = z
  .object({
    format: z.literal("h264_annex_b"),
  })
  .strict();

export const DevicePreviewStreamProfileSchema = z.discriminatedUnion("format", [
  DevicePreviewJpegStreamProfileSchema,
  DevicePreviewH264StreamProfileSchema,
]);
export type DevicePreviewStreamProfile = z.infer<typeof DevicePreviewStreamProfileSchema>;

export const devicePreviewStreamStopReasonValues = [
  "client_closed",
  "preview_closed",
  "proxy_offline",
  "relay_shutdown",
  "stream_error",
] as const;
export const DevicePreviewStreamStopReasonSchema = z.enum(devicePreviewStreamStopReasonValues);
export type DevicePreviewStreamStopReason = z.infer<typeof DevicePreviewStreamStopReasonSchema>;

const NormalizedCoordinateSchema = z.number().finite().min(0).max(1);
export const devicePreviewTouchPhaseValues = ["down", "move", "up"] as const;
export const DevicePreviewTouchPhaseSchema = z.enum(devicePreviewTouchPhaseValues);
export type DevicePreviewTouchPhase = z.infer<typeof DevicePreviewTouchPhaseSchema>;

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
  z
    .object({
      kind: z.literal("touch"),
      phase: DevicePreviewTouchPhaseSchema,
      x: NormalizedCoordinateSchema,
      y: NormalizedCoordinateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string().min(1).max(DEVICE_PREVIEW_TEXT_MAX_LENGTH),
    })
    .strict(),
  z
    .object({
      kind: z.literal("button"),
      button: z.enum(["home", "back"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("orientation"),
      orientation: DevicePreviewOrientationSchema,
    })
    .strict(),
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

export const DevicePreviewStreamRegisterResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_stream_register_response"),
    success: z.literal(true),
    error: z.never().optional(),
  }),
  z.object({
    type: z.literal("device_preview_stream_register_response"),
    success: z.literal(false),
    error: z.string().min(1).max(DEVICE_PREVIEW_ERROR_MAX_LENGTH),
  }),
]);
export type DevicePreviewStreamRegisterResponse = z.infer<
  typeof DevicePreviewStreamRegisterResponseSchema
>;

const DevicePreviewStreamFlowBaseSchema = z.object({
  type: z.literal("device_preview_stream_flow"),
  streamId: IdSchema,
});

export const DevicePreviewStreamFlowSchema = z.discriminatedUnion("paused", [
  DevicePreviewStreamFlowBaseSchema.extend({
    paused: z.literal(true),
    resyncRequired: z.literal(false),
  }).strict(),
  DevicePreviewStreamFlowBaseSchema.extend({
    paused: z.literal(false),
    resyncRequired: z.boolean(),
  }).strict(),
]);
export type DevicePreviewStreamFlow = z.infer<typeof DevicePreviewStreamFlowSchema>;

export const DevicePreviewStreamServerMessageSchema = z.union([
  DevicePreviewStreamRegisterResponseSchema,
  DevicePreviewStreamFlowSchema,
]);
export type DevicePreviewStreamServerMessage = z.infer<
  typeof DevicePreviewStreamServerMessageSchema
>;
