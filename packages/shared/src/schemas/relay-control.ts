import { z } from "zod";
import { IdSchema } from "./id.js";
import {
  AgentStatusPayloadSchema,
  createSessionIdentitySchema,
  PtyStatePayloadSchema,
  sessionStateValues,
} from "./session.js";
import { ApprovalOptionSchema, ToolApprovePayloadSchema, ToolDenyPayloadSchema } from "./tool.js";
import {
  VoiceCapabilitiesSchema,
  VoiceConfigUpdateSchema,
  VoiceProviderConfigSchema,
  VoiceSummaryReasonSchema,
  voiceRegionValues,
} from "./voice.js";
import { RelayErrorCode } from "../constants/relay-errors.js";
import { ControlErrorCode } from "../constants/control-errors.js";
import { providerValues, ptyOwnerValues, sessionModeValues } from "../constants/enums.js";
import { PTY_INITIAL_MAX_COLS, PTY_INITIAL_MAX_ROWS } from "../constants/pty.js";
import {
  PreviewHtmlEntriesSchema,
  WebPreviewNameSchema,
  PreviewSummarySchema,
  TunnelProviderSchema,
  WebPreviewCapabilitySchema,
  WebPreviewPathSchema,
  WebPreviewSourceInputSchema,
} from "./web-preview.js";
import {
  DevicePreviewCapabilitySchema,
  DevicePreviewH264StreamProfileSchema,
  DevicePreviewInputSchema,
  DevicePreviewJpegStreamProfileSchema,
  DevicePreviewNameSchema,
  DevicePreviewStreamFormatSchema,
  DevicePreviewStreamProfileSchema,
  DevicePreviewStreamStopReasonSchema,
  DevicePreviewSummarySchema,
  DevicePreviewTargetSchema,
} from "./device-preview.js";
import { PreviewScopeSchema } from "./preview-scope.js";

// Web, Relay 与 Proxy 的控制协议版本。只在握手或消息协议不兼容时递增，
// 不与任何组件的 npm 版本绑定。
// 注册、响应和状态推送允许新增非必需的描述字段：接收方校验已知字段并剥离未知字段。
// 改变必填字段、状态或执行语义仍属于协议变更，不能依赖未知字段被忽略。
export const RELAY_CONTROL_PROTOCOL_VERSION = 1 as const;

// 控制消息中复用的子类型
export const ProxyInfoSchema = z.object({
  proxyId: IdSchema,
  name: z.string().optional(),
  version: z.string().min(1).max(64),
  online: z.boolean(),
  sessions: z.array(z.string()),
});
export type ProxyInfo = z.infer<typeof ProxyInfoSchema>;

export const RelayClientInfoSchema = z.object({
  clientId: IdSchema,
  proxyId: IdSchema.optional(),
  connectedAt: z.number().int().nonnegative(),
  current: z.boolean().optional(),
  userAgent: z.string().optional(),
  platform: z.string().optional(),
  maxTouchPoints: z.number().int().nonnegative().optional(),
  browserName: z.string().min(1),
  osName: z.string().min(1),
  deviceKind: z.enum(["desktop", "tablet", "phone", "unknown"]),
  remoteAddress: z.string().optional(),
});
export type RelayClientInfo = z.infer<typeof RelayClientInfoSchema>;

export const AgentCliAvailabilitySchema = z.object({
  available: z.boolean(),
  command: z.string().optional(),
  error: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
});
export type AgentCliAvailability = z.infer<typeof AgentCliAvailabilitySchema>;

export const AgentCliStatusSchema = z.object({
  claude: AgentCliAvailabilitySchema,
  codex: AgentCliAvailabilitySchema,
  kimi: AgentCliAvailabilitySchema,
});
export type AgentCliStatus = z.infer<typeof AgentCliStatusSchema>;

export const DirEntrySchema = z.object({ name: z.string(), isDir: z.boolean() });
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const FileTreeGroupSchema = z.object({
  path: z.string(),
  entries: z.array(DirEntrySchema),
});
export type FileTreeGroup = z.infer<typeof FileTreeGroupSchema>;

export const CommandEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  source: z.string(),
});
export type CommandEntry = z.infer<typeof CommandEntrySchema>;

export const HistorySessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectDir: z.string(),
  updatedAt: z.number(),
  provider: z.enum(providerValues),
  preferredMode: z.enum(sessionModeValues).optional(),
});
export type HistorySession = z.infer<typeof HistorySessionSchema>;

const SessionHistoryPositionShape = {
  timestamp: z.number().optional(),
  cursor: z.string().optional(),
};

export const SessionHistoryMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.enum(["user", "assistant", "system"]),
    text: z.string(),
    ...SessionHistoryPositionShape,
  }),
  z.object({
    role: z.literal("activity"),
    text: z.string(),
    toolId: IdSchema,
    toolName: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["running", "done", "error"]),
    ...SessionHistoryPositionShape,
  }),
]);
export type SessionHistoryMessage = z.infer<typeof SessionHistoryMessageSchema>;

type RelayControlDirection = "proxy_to_client" | "client_to_proxy";
type EmptyShape = Record<never, never>;
const RequestIdShape = { requestId: IdSchema.optional() };
const RequiredRequestIdShape = { requestId: IdSchema };
const ControlErrorCodeSchema = z.enum(
  Object.values(ControlErrorCode) as [ControlErrorCode, ...ControlErrorCode[]],
);
const RequestErrorShape = {
  error: z.string().optional(),
  errorCode: ControlErrorCodeSchema.optional(),
};
const NoRequestErrorShape = {
  error: z.never().optional(),
  errorCode: z.never().optional(),
};
const RequiredRequestErrorShape = {
  error: z.string().min(1),
  errorCode: ControlErrorCodeSchema,
};
const RemoteFileDispositionSchema = z.enum(["inline", "download"]);
const RemoteFileUploadKindSchema = z.enum(["clipboard_image", "file"]);

type ControlDefinition<T extends string, S extends z.ZodRawShape> = {
  type: T;
  directions: ReadonlySet<RelayControlDirection>;
  schema: z.ZodObject<{ type: z.ZodLiteral<T> } & S>;
};

function control<T extends string>(type: T): ControlDefinition<T, EmptyShape>;
function control<T extends string>(
  type: T,
  shape: undefined,
  directions: RelayControlDirection | RelayControlDirection[],
): ControlDefinition<T, EmptyShape>;
function control<T extends string, S extends z.ZodRawShape>(
  type: T,
  shape: S,
  directions?: RelayControlDirection | RelayControlDirection[],
): ControlDefinition<T, S>;
function control<T extends string, S extends z.ZodRawShape>(
  type: T,
  shape?: S,
  directions?: RelayControlDirection | RelayControlDirection[],
): ControlDefinition<T, S | EmptyShape> {
  return {
    type,
    directions: new Set(Array.isArray(directions) ? directions : directions ? [directions] : []),
    schema: z.object({
      type: z.literal(type),
      ...(shape ?? {}),
    }) as z.ZodObject<{ type: z.ZodLiteral<T> } & (S | EmptyShape)>,
  };
}

function strictControl<T extends string, S extends z.ZodRawShape>(
  type: T,
  shape: S,
  directions?: RelayControlDirection | RelayControlDirection[],
): ControlDefinition<T, S> {
  return {
    type,
    directions: new Set(Array.isArray(directions) ? directions : directions ? [directions] : []),
    schema: z
      .object({
        type: z.literal(type),
        ...shape,
      })
      .strict() as ControlDefinition<T, S>["schema"],
  };
}

function controlSchema<T extends string, S extends z.ZodType>(
  type: T,
  schema: S,
  directions?: RelayControlDirection | RelayControlDirection[],
): { type: T; directions: ReadonlySet<RelayControlDirection>; schema: S } {
  return {
    type,
    directions: new Set(Array.isArray(directions) ? directions : directions ? [directions] : []),
    schema,
  };
}

const ProxySelectResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("proxy_select_response"),
    ...RequestIdShape,
    success: z.literal(true),
    ...NoRequestErrorShape,
    proxyId: IdSchema,
    bindingId: IdSchema,
  }),
  z.object({
    type: z.literal("proxy_select_response"),
    ...RequestIdShape,
    success: z.literal(false),
    proxyId: z.never().optional(),
    bindingId: z.never().optional(),
    ...RequestErrorShape,
  }),
]);

const ClientRegisterResponseSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("client_register_response"),
    protocolVersion: z.literal(RELAY_CONTROL_PROTOCOL_VERSION),
    status: z.literal("restored"),
    proxyId: IdSchema,
    bindingId: IdSchema,
  }),
  z.object({
    type: z.literal("client_register_response"),
    protocolVersion: z.literal(RELAY_CONTROL_PROTOCOL_VERSION),
    status: z.literal("proxy_offline"),
    proxyId: IdSchema,
    bindingId: IdSchema,
  }),
  z.object({
    type: z.literal("client_register_response"),
    protocolVersion: z.literal(RELAY_CONTROL_PROTOCOL_VERSION),
    status: z.literal("new"),
    // 已知的绑定字段不能作为扩展信息被忽略；new 状态明确表示尚未绑定。
    proxyId: z.never().optional(),
    bindingId: z.never().optional(),
  }),
]);

const PreviewCreateResponseSchema = z.discriminatedUnion("accepted", [
  z.object({
    type: z.literal("preview_create_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    accepted: z.literal(true),
    ...NoRequestErrorShape,
    previewId: IdSchema,
  }),
  z.object({
    type: z.literal("preview_create_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    accepted: z.literal(false),
    previewId: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewCreateResponseSchema = z.discriminatedUnion("accepted", [
  z.object({
    type: z.literal("device_preview_create_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    accepted: z.literal(true),
    ...NoRequestErrorShape,
    previewId: IdSchema,
  }),
  z.object({
    type: z.literal("device_preview_create_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    accepted: z.literal(false),
    previewId: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const PreviewCapabilityResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("preview_capability_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
    capability: WebPreviewCapabilitySchema,
  }),
  z.object({
    type: z.literal("preview_capability_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    success: z.literal(false),
    capability: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewCapabilityResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_capability_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
    capability: DevicePreviewCapabilitySchema,
  }),
  z.object({
    type: z.literal("device_preview_capability_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    success: z.literal(false),
    capability: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const ProxyInfoRequestSchema = z
  .object({
    type: z.literal("proxy_info_request"),
    ...RequestIdShape,
  })
  .strict();

const ProxyInfoResponseSchema = z.object({
  type: z.literal("proxy_info"),
  ...RequestIdShape,
  homePath: z.string(),
  agentCli: AgentCliStatusSchema,
});
const PreviewStaticInspectResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("preview_static_inspect_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
    entryPath: WebPreviewPathSchema.optional(),
    htmlEntries: PreviewHtmlEntriesSchema,
  }),
  z.object({
    type: z.literal("preview_static_inspect_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    success: z.literal(false),
    entryPath: z.never().optional(),
    htmlEntries: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const PreviewRenameResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("preview_rename_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
  }),
  z.object({
    type: z.literal("preview_rename_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(false),
    ...RequiredRequestErrorShape,
  }),
]);

const PreviewReconnectResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("preview_reconnect_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
  }),
  z.object({
    type: z.literal("preview_reconnect_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(false),
    ...RequiredRequestErrorShape,
  }),
]);

const PreviewCloseResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("preview_close_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
  }),
  z.object({
    type: z.literal("preview_close_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(false),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewTargetsResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_targets_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
    targets: z.array(DevicePreviewTargetSchema).max(1_024),
  }),
  z.object({
    type: z.literal("device_preview_targets_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    success: z.literal(false),
    targets: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewRenameResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_rename_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
  }),
  z.object({
    type: z.literal("device_preview_rename_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(false),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewReconnectResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_reconnect_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
  }),
  z.object({
    type: z.literal("device_preview_reconnect_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(false),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewCloseResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_close_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
  }),
  z.object({
    type: z.literal("device_preview_close_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    operationId: IdSchema,
    previewId: IdSchema,
    success: z.literal(false),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewStreamUrlResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_stream_url_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    previewId: IdSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
    url: z.string().min(1).max(4_096),
    leaseId: IdSchema,
    expiresAt: z.number().int().nonnegative(),
    controlMode: z.enum(["controller", "view_only"]),
  }),
  z.object({
    type: z.literal("device_preview_stream_url_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    previewId: IdSchema,
    success: z.literal(false),
    url: z.never().optional(),
    leaseId: z.never().optional(),
    expiresAt: z.never().optional(),
    controlMode: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewStreamStartResponseBaseShape = {
  type: z.literal("device_preview_stream_start_response"),
  streamId: IdSchema,
  leaseId: IdSchema,
  previewId: IdSchema,
};

const DevicePreviewStreamStartSuccessSchema = z
  .object({
    ...DevicePreviewStreamStartResponseBaseShape,
    success: z.literal(true),
    ...NoRequestErrorShape,
    format: DevicePreviewStreamFormatSchema,
    width: z.number().int().positive().max(16_384).optional(),
    height: z.number().int().positive().max(16_384).optional(),
  })

  .superRefine((response, context) => {
    if ((response.width === undefined) === (response.height === undefined)) return;
    context.addIssue({
      code: "custom",
      path: response.width === undefined ? ["width"] : ["height"],
      message: "Device preview stream dimensions must include both width and height",
    });
  });

const DevicePreviewStreamStartResponseSchema = z.discriminatedUnion("success", [
  DevicePreviewStreamStartSuccessSchema,
  z.object({
    ...DevicePreviewStreamStartResponseBaseShape,
    success: z.literal(false),
    format: z.never().optional(),
    width: z.never().optional(),
    height: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewStreamCompleteSchema = z.object({
  type: z.literal("device_preview_stream_complete"),
  streamId: IdSchema,
  leaseId: IdSchema,
  previewId: IdSchema,
  success: z.literal(false),
  error: z.string().min(1),
});
const DevicePreviewStreamStartBaseShape = {
  type: z.literal("device_preview_stream_start"),
  streamId: IdSchema,
  leaseId: IdSchema,
  previewId: IdSchema,
};

const DevicePreviewStreamStartSchema = z.discriminatedUnion("format", [
  z
    .object({
      ...DevicePreviewStreamStartBaseShape,
      ...DevicePreviewJpegStreamProfileSchema.shape,
    })
    .strict(),
  z
    .object({
      ...DevicePreviewStreamStartBaseShape,
      ...DevicePreviewH264StreamProfileSchema.shape,
    })
    .strict(),
]);

const DevicePreviewInputAckSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_input_ack"),
    scope: PreviewScopeSchema,
    leaseId: IdSchema,
    inputSeq: z.number().int().min(0).max(0xffffffff),
    success: z.literal(true),
    ...NoRequestErrorShape,
  }),
  z.object({
    type: z.literal("device_preview_input_ack"),
    scope: PreviewScopeSchema,
    leaseId: IdSchema,
    inputSeq: z.number().int().min(0).max(0xffffffff),
    success: z.literal(false),
    ...RequiredRequestErrorShape,
  }),
]);

const DevicePreviewControlClaimResponseSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("device_preview_control_claim_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    leaseId: IdSchema,
    success: z.literal(true),
    ...NoRequestErrorShape,
    controlMode: z.literal("controller"),
  }),
  z.object({
    type: z.literal("device_preview_control_claim_response"),
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    leaseId: IdSchema,
    success: z.literal(false),
    controlMode: z.never().optional(),
    ...RequiredRequestErrorShape,
  }),
]);

const SessionPermissionModeSchema = z.enum([
  "default",
  "auto",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

const AgentJsonSessionCreateSchema = z
  .object({
    type: z.literal("session_create"),
    ...RequiredRequestIdShape,
    kind: z.literal("agent"),
    cwd: z.string(),
    name: z.string().optional(),
    provider: z.enum(providerValues),
    mode: z.literal("json"),
    resumeSessionId: z.string().optional(),
    permissionMode: SessionPermissionModeSchema.optional(),
  })
  .strict();

const AgentPtySessionCreateSchema = z
  .object({
    type: z.literal("session_create"),
    ...RequiredRequestIdShape,
    kind: z.literal("agent"),
    cwd: z.string(),
    name: z.string().optional(),
    provider: z.enum(providerValues),
    mode: z.literal("pty"),
    resumeSessionId: z.string().optional(),
    cols: z.number().int().positive().max(PTY_INITIAL_MAX_COLS),
    rows: z.number().int().positive().max(PTY_INITIAL_MAX_ROWS),
    permissionMode: SessionPermissionModeSchema.optional(),
  })
  .strict();

const TerminalSessionCreateSchema = z
  .object({
    type: z.literal("session_create"),
    ...RequiredRequestIdShape,
    kind: z.literal("terminal"),
    name: z.string().optional(),
    mode: z.literal("pty"),
    cols: z.number().int().positive().max(PTY_INITIAL_MAX_COLS),
    rows: z.number().int().positive().max(PTY_INITIAL_MAX_ROWS),
  })
  .strict();

const SessionCreateSchema = z.discriminatedUnion("mode", [
  AgentJsonSessionCreateSchema,
  z.discriminatedUnion("kind", [AgentPtySessionCreateSchema, TerminalSessionCreateSchema]),
]);

const SessionCreateSuccessBaseShape = {
  ...NoRequestErrorShape,
  activeWriterPid: z.never().optional(),
  type: z.literal("session_create_response"),
  ...RequiredRequestIdShape,
  success: z.literal(true),
  sessionId: IdSchema,
  cwd: z.string(),
  lastActive: z.number(),
  name: z.string().optional(),
  nameLocked: z.boolean().optional(),
};

const SessionCreateSuccessResponseSchema = z.discriminatedUnion("mode", [
  z.object({
    ...SessionCreateSuccessBaseShape,
    kind: z.literal("agent"),
    mode: z.literal("json"),
    ptyOwner: z.never().optional(),
    provider: z.enum(providerValues),
  }),
  z.discriminatedUnion("kind", [
    z.object({
      ...SessionCreateSuccessBaseShape,
      kind: z.literal("agent"),
      mode: z.literal("pty"),
      provider: z.enum(providerValues),
      ptyOwner: z.enum(ptyOwnerValues),
    }),
    z.object({
      ...SessionCreateSuccessBaseShape,
      kind: z.literal("terminal"),
      mode: z.literal("pty"),
      provider: z.literal("claude"),
      ptyOwner: z.literal("proxy-hosted"),
    }),
  ]),
]);

const SessionCreateResponseSchema = z.discriminatedUnion("success", [
  SessionCreateSuccessResponseSchema,
  z.object({
    type: z.literal("session_create_response"),
    ...RequiredRequestIdShape,
    success: z.literal(false),
    sessionId: z.never().optional(),
    cwd: z.never().optional(),
    lastActive: z.never().optional(),
    name: z.never().optional(),
    nameLocked: z.never().optional(),
    kind: z.never().optional(),
    mode: z.never().optional(),
    provider: z.never().optional(),
    ptyOwner: z.never().optional(),
    ...RequiredRequestErrorShape,
    activeWriterPid: z.number().int().positive().optional(),
  }),
]);

// 中转服务器控制消息，独立于 MessageEnvelope 的传输层协议
const relayControlDefinitions = [
  control("proxy_register", {
    protocolVersion: z.literal(RELAY_CONTROL_PROTOCOL_VERSION),
    proxyId: IdSchema,
    name: z.string().optional(),
    proxyVersion: z.string().min(1).max(64),
  }),
  control("proxy_register_response", {
    protocolVersion: z.literal(RELAY_CONTROL_PROTOCOL_VERSION),
    status: z.enum(["new", "reconnected"]),
    relayVersion: z.string().min(1).max(64),
    // Relay rotates this nonce for every successful main Proxy registration. The dedicated image
    // stream socket must present it before Relay accepts frames, so a superseded Proxy connection
    // cannot keep publishing into a newly registered Proxy with the same persistent proxyId.
    connectionId: IdSchema,
  }),
  control("proxy_list_request", RequestIdShape),
  control("proxy_list_response", {
    ...RequestIdShape,
    proxies: z.array(ProxyInfoSchema),
  }),
  control("proxy_remove", {
    ...RequiredRequestIdShape,
    proxyId: IdSchema,
  }),
  control("proxy_remove_response", {
    ...RequiredRequestIdShape,
    proxyId: IdSchema,
    success: z.boolean(),
    ...RequestErrorShape,
  }),
  control("relay_client_list_request", RequestIdShape),
  control("relay_client_list_response", {
    ...RequestIdShape,
    clients: z.array(RelayClientInfoSchema),
  }),
  control("relay_client_kick", { ...RequiredRequestIdShape, clientId: IdSchema }),
  control("relay_client_kick_response", {
    ...RequiredRequestIdShape,
    clientId: IdSchema,
    success: z.boolean(),
    ...RequestErrorShape,
  }),
  control("relay_client_kicked", {
    reason: z.string().optional(),
  }),
  control("remote_file_url_request", {
    ...RequiredRequestIdShape,
    sessionId: IdSchema,
    path: z.string().min(1),
    disposition: RemoteFileDispositionSchema,
  }),
  control("remote_file_url_response", {
    ...RequiredRequestIdShape,
    ...RequestErrorShape,
    sessionId: IdSchema,
    path: z.string().optional(),
    success: z.boolean(),
    url: z.string().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
  }),
  control("remote_file_metadata_request", {
    ...RequiredRequestIdShape,
    sessionId: IdSchema,
    path: z.string().min(1),
  }),
  control("remote_file_metadata_response", {
    ...RequiredRequestIdShape,
    ...RequestErrorShape,
    sessionId: IdSchema,
    path: z.string().optional(),
    success: z.boolean(),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    fileName: z.string().optional(),
  }),
  control("remote_file_stream_request", {
    streamId: IdSchema,
    sessionId: IdSchema,
    path: z.string().min(1),
    disposition: RemoteFileDispositionSchema,
  }),
  control("remote_file_stream_response", {
    ...RequestErrorShape,
    streamId: IdSchema,
    sessionId: IdSchema,
    success: z.boolean(),
    path: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    fileName: z.string().optional(),
  }),
  control("remote_file_stream_complete", {
    ...RequestErrorShape,
    streamId: IdSchema,
    success: z.boolean(),
  }),
  control("remote_file_stream_cancel", {
    streamId: IdSchema,
  }),
  control("remote_file_upload_url_request", {
    ...RequiredRequestIdShape,
    sessionId: IdSchema,
    kind: RemoteFileUploadKindSchema,
    fileName: z.string().optional(),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative().optional(),
  }),
  control("remote_file_upload_url_response", {
    ...RequiredRequestIdShape,
    ...RequestErrorShape,
    sessionId: IdSchema,
    success: z.boolean(),
    uploadUrl: z.string().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
  }),
  control("remote_file_upload_stream_request", {
    uploadId: IdSchema,
    sessionId: IdSchema,
    kind: RemoteFileUploadKindSchema,
    fileName: z.string().optional(),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative().optional(),
  }),
  control("remote_file_upload_stream_complete", {
    uploadId: IdSchema,
  }),
  control("remote_file_upload_stream_cancel", {
    uploadId: IdSchema,
  }),
  control("remote_file_upload_stream_response", {
    ...RequestErrorShape,
    uploadId: IdSchema,
    sessionId: IdSchema,
    success: z.boolean(),
    path: z.string().optional(),
  }),
  control("proxy_select", { ...RequestIdShape, proxyId: IdSchema }),
  controlSchema("proxy_select_response", ProxySelectResponseSchema),
  control("relay_error", {
    code: z.enum(Object.values(RelayErrorCode) as [RelayErrorCode, ...RelayErrorCode[]]),
    message: z.string(),
    // 可选 requestId: relay 把 client 发来 raw 的 requestId 字段透传回来,
    // client 侧 waitForMessage 据此把对应 pending request 立即拒掉而不必等到 timeout。
    requestId: IdSchema.optional(),
  }),

  // Voice Pilot config is relay-local: client reads/updates the relay's stored provider settings.
  control("voice_config_request", RequestIdShape),
  control("voice_config_response", {
    ...RequestIdShape,
    ...RequestErrorShape,
    config: VoiceProviderConfigSchema.optional(),
  }),
  control("voice_config_update", {
    ...RequestIdShape,
    config: VoiceConfigUpdateSchema,
  }),
  control("voice_config_update_response", {
    ...RequestIdShape,
    ...RequestErrorShape,
    success: z.boolean(),
    config: VoiceProviderConfigSchema.optional(),
  }),
  control("voice_config_test", {
    ...RequestIdShape,
    config: VoiceConfigUpdateSchema.optional(),
  }),
  control("voice_config_test_response", {
    ...RequestIdShape,
    ...RequestErrorShape,
    success: z.boolean(),
    audioBase64: z.string().optional(),
    audioSampleRate: z.number().int().positive().optional(),
    audioEncoding: z.literal("pcm_s16le").optional(),
    transcript: z.string().optional(),
  }),
  control("voice_capabilities_request", {
    ...RequestIdShape,
    region: z.enum(voiceRegionValues).optional(),
  }),
  control("voice_capabilities_response", {
    ...RequestIdShape,
    ...RequestErrorShape,
    capabilities: VoiceCapabilitiesSchema.optional(),
  }),

  // Lightweight latency probes. These measure synthetic round-trip latency for the transport
  // segments and intentionally stay separate from PTY input echo tracing.
  control("latency_web_relay_ping", RequiredRequestIdShape),
  control("latency_web_relay_pong", {
    ...RequiredRequestIdShape,
    relayNow: z.number().optional(),
  }),
  control("latency_relay_proxy_request", RequiredRequestIdShape),
  control("latency_relay_proxy_response", {
    ...RequiredRequestIdShape,
    success: z.boolean(),
    rttMs: z.number().nonnegative().optional(),
    error: z.string().optional(),
  }),
  control("latency_relay_proxy_ping", {
    ...RequiredRequestIdShape,
    relayNow: z.number().optional(),
  }),
  control("latency_relay_proxy_pong", {
    ...RequiredRequestIdShape,
    proxyNow: z.number().optional(),
  }),
  control("latency_web_proxy_ping", RequiredRequestIdShape, "client_to_proxy"),
  control(
    "latency_web_proxy_pong",
    { ...RequiredRequestIdShape, proxyNow: z.number().optional() },
    "proxy_to_client",
  ),

  // Web preview is independent from Agent/terminal sessions. Relay rewrites requestId and routes
  // every response to the exact requesting WebSocket; only the two push messages are broadcast.
  strictControl(
    "preview_capability_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      refreshPath: z.boolean(),
    },
    "client_to_proxy",
  ),
  controlSchema("preview_capability_response", PreviewCapabilityResponseSchema, "proxy_to_client"),
  strictControl(
    "preview_static_inspect_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      path: WebPreviewPathSchema,
    },
    "client_to_proxy",
  ),
  controlSchema(
    "preview_static_inspect_response",
    PreviewStaticInspectResponseSchema,
    "proxy_to_client",
  ),
  strictControl(
    "preview_create_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      operationId: IdSchema,
      source: WebPreviewSourceInputSchema,
      tunnelProvider: TunnelProviderSchema,
      name: WebPreviewNameSchema.optional(),
    },
    "client_to_proxy",
  ),
  controlSchema("preview_create_response", PreviewCreateResponseSchema, "proxy_to_client"),
  strictControl(
    "preview_list_request",
    { ...RequiredRequestIdShape, scope: PreviewScopeSchema },
    "client_to_proxy",
  ),
  control(
    "preview_list_response",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      epoch: IdSchema,
      revision: z.number().int().nonnegative(),
      previews: z.array(PreviewSummarySchema),
    },
    "proxy_to_client",
  ),
  strictControl(
    "preview_rename_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      operationId: IdSchema,
      previewId: IdSchema,
      name: WebPreviewNameSchema,
    },
    "client_to_proxy",
  ),
  controlSchema("preview_rename_response", PreviewRenameResponseSchema, "proxy_to_client"),
  strictControl(
    "preview_reconnect_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      operationId: IdSchema,
      previewId: IdSchema,
    },
    "client_to_proxy",
  ),
  controlSchema("preview_reconnect_response", PreviewReconnectResponseSchema, "proxy_to_client"),
  strictControl(
    "preview_close_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      operationId: IdSchema,
      previewId: IdSchema,
    },
    "client_to_proxy",
  ),
  controlSchema("preview_close_response", PreviewCloseResponseSchema, "proxy_to_client"),
  control("preview_state_event", {
    epoch: IdSchema,
    revision: z.number().int().nonnegative(),
    preview: PreviewSummarySchema,
  }),
  control("preview_removed_event", {
    epoch: IdSchema,
    revision: z.number().int().nonnegative(),
    previewId: IdSchema,
  }),
  control(
    "preview_state_push",
    {
      scope: PreviewScopeSchema,
      epoch: IdSchema,
      revision: z.number().int().nonnegative(),
      preview: PreviewSummarySchema,
    },
    "proxy_to_client",
  ),
  control(
    "preview_removed_push",
    {
      scope: PreviewScopeSchema,
      epoch: IdSchema,
      revision: z.number().int().nonnegative(),
      previewId: IdSchema,
    },
    "proxy_to_client",
  ),

  // Device previews are a sibling of Web previews under the product-level Preview entry, but
  // their data plane is private. Management and input use the authenticated main sockets;
  // JPEG/H.264 frames use `/proxy-stream` plus a one-use HTTP stream URL issued by Relay.
  strictControl(
    "device_preview_capability_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      refreshPath: z.boolean(),
    },
    "client_to_proxy",
  ),
  controlSchema(
    "device_preview_capability_response",
    DevicePreviewCapabilityResponseSchema,
    "proxy_to_client",
  ),
  strictControl(
    "device_preview_targets_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      refresh: z.boolean(),
    },
    "client_to_proxy",
  ),
  controlSchema(
    "device_preview_targets_response",
    DevicePreviewTargetsResponseSchema,
    "proxy_to_client",
  ),
  strictControl(
    "device_preview_create_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      operationId: IdSchema,
      targetId: IdSchema,
      name: DevicePreviewNameSchema.optional(),
    },
    "client_to_proxy",
  ),
  controlSchema(
    "device_preview_create_response",
    DevicePreviewCreateResponseSchema,
    "proxy_to_client",
  ),
  strictControl(
    "device_preview_list_request",
    { ...RequiredRequestIdShape, scope: PreviewScopeSchema },
    "client_to_proxy",
  ),
  control(
    "device_preview_list_response",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      epoch: IdSchema,
      revision: z.number().int().nonnegative(),
      previews: z.array(DevicePreviewSummarySchema).max(1_024),
    },
    "proxy_to_client",
  ),
  strictControl(
    "device_preview_rename_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      operationId: IdSchema,
      previewId: IdSchema,
      name: DevicePreviewNameSchema,
    },
    "client_to_proxy",
  ),
  controlSchema(
    "device_preview_rename_response",
    DevicePreviewRenameResponseSchema,
    "proxy_to_client",
  ),
  strictControl(
    "device_preview_reconnect_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      operationId: IdSchema,
      previewId: IdSchema,
    },
    "client_to_proxy",
  ),
  controlSchema(
    "device_preview_reconnect_response",
    DevicePreviewReconnectResponseSchema,
    "proxy_to_client",
  ),
  strictControl(
    "device_preview_close_request",
    {
      ...RequiredRequestIdShape,
      scope: PreviewScopeSchema,
      operationId: IdSchema,
      previewId: IdSchema,
    },
    "client_to_proxy",
  ),
  controlSchema(
    "device_preview_close_response",
    DevicePreviewCloseResponseSchema,
    "proxy_to_client",
  ),
  control("device_preview_state_event", {
    epoch: IdSchema,
    revision: z.number().int().nonnegative(),
    preview: DevicePreviewSummarySchema,
  }),
  control("device_preview_removed_event", {
    epoch: IdSchema,
    revision: z.number().int().nonnegative(),
    previewId: IdSchema,
  }),
  control(
    "device_preview_state_push",
    {
      scope: PreviewScopeSchema,
      epoch: IdSchema,
      revision: z.number().int().nonnegative(),
      preview: DevicePreviewSummarySchema,
    },
    "proxy_to_client",
  ),
  control(
    "device_preview_removed_push",
    {
      scope: PreviewScopeSchema,
      epoch: IdSchema,
      revision: z.number().int().nonnegative(),
      previewId: IdSchema,
    },
    "proxy_to_client",
  ),
  strictControl("device_preview_stream_url_request", {
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    previewId: IdSchema,
    profile: DevicePreviewStreamProfileSchema,
  }),
  controlSchema("device_preview_stream_url_response", DevicePreviewStreamUrlResponseSchema),
  controlSchema("device_preview_stream_start", DevicePreviewStreamStartSchema),
  controlSchema("device_preview_stream_start_response", DevicePreviewStreamStartResponseSchema),
  strictControl("device_preview_stream_stop", {
    streamId: IdSchema,
    reason: DevicePreviewStreamStopReasonSchema,
  }),
  controlSchema("device_preview_stream_complete", DevicePreviewStreamCompleteSchema),
  strictControl(
    "device_preview_input",
    {
      scope: PreviewScopeSchema,
      leaseId: IdSchema,
      inputSeq: z.number().int().min(0).max(0xffffffff),
      input: DevicePreviewInputSchema,
    },
    "client_to_proxy",
  ),
  controlSchema("device_preview_input_ack", DevicePreviewInputAckSchema, "proxy_to_client"),
  // Relay-internal ordering barrier. It is deliberately absent from both public direction sets:
  // browsers cannot abort another viewer's queued input, and Proxy never sends it to browsers.
  strictControl("device_preview_input_revoke", {
    leaseId: IdSchema,
    reason: z.literal("control_taken_over"),
  }),
  strictControl("device_preview_control_claim_request", {
    ...RequiredRequestIdShape,
    scope: PreviewScopeSchema,
    leaseId: IdSchema,
  }),
  controlSchema("device_preview_control_claim_response", DevicePreviewControlClaimResponseSchema),
  control("device_preview_control_revoked_push", {
    scope: PreviewScopeSchema,
    leaseId: IdSchema,
    reason: z.enum(["taken_over", "stream_closed", "proxy_offline", "lease_expired"]),
  }),

  // 客户端注册协议
  control("client_register", {
    protocolVersion: z.literal(RELAY_CONTROL_PROTOCOL_VERSION),
    clientId: IdSchema,
    userAgent: z.string().optional(),
    platform: z.string().optional(),
    maxTouchPoints: z.number().int().nonnegative().optional(),
    browserName: z.string().min(1),
    osName: z.string().min(1),
    deviceKind: z.enum(["desktop", "tablet", "phone", "unknown"]),
  }),
  controlSchema("client_register_response", ClientRegisterResponseSchema),

  // Proxy 离线通知
  control("proxy_offline", {
    proxyId: IdSchema,
  }),

  // 用户明确删除了离线 Proxy。与列表暂时缺项分开建模，客户端据此永久清理选择态。
  control("proxy_removed", {
    proxyId: IdSchema,
  }),

  // Proxy 主动断开，relay 立即清理资源
  control("proxy_disconnect", {
    proxyId: IdSchema,
  }),

  // Proxy 重连后通知 client 恢复
  control("proxy_online", {
    proxyId: IdSchema,
  }),

  // 目录列表请求与响应
  strictControl(
    "dir_list_request",
    {
      ...RequestIdShape,
      path: z.string(),
      includeHidden: z.boolean(),
    },
    "client_to_proxy",
  ),
  control(
    "dir_list_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      entries: z.array(DirEntrySchema),
      path: z.string(),
      includeHidden: z.boolean(),
    },
    "proxy_to_client",
  ),

  // 目录创建请求与响应
  control("dir_create_request", { ...RequestIdShape, path: z.string() }, "client_to_proxy"),
  control(
    "dir_create_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      path: z.string(),
      success: z.boolean(),
    },
    "proxy_to_client",
  ),

  // 命令列表推送，proxy 将可用命令列表推给 client
  control(
    "command_list_push",
    {
      sessionId: IdSchema,
      commands: z.array(CommandEntrySchema),
    },
    "proxy_to_client",
  ),

  // 文件树推送: 按目录分组, 首组 path 即为 session cwd。
  // 前端把它写入普通目录树；includeHidden=true 的按需响应使用独立缓存。
  control(
    "file_tree_push",
    {
      groups: z.array(FileTreeGroupSchema),
    },
    "proxy_to_client",
  ),

  // 会话列表请求与权限模式变更
  strictControl("session_list_request", {}, "client_to_proxy"),
  control(
    "permission_mode_change",
    {
      mode: z.enum(["default", "auto_accept", "plan"]),
      // sessionId 可选：传入时 proxy 按该会话的 mode 分叉（PTY 发 Tab ANSI），未传走全局日志行为
      sessionId: IdSchema.optional(),
    },
    "client_to_proxy",
  ),

  // 会话历史浏览
  control("session_history_request", RequiredRequestIdShape, "client_to_proxy"),
  control(
    "session_history_response",
    {
      ...RequiredRequestIdShape,
      ...RequestErrorShape,
      success: z.boolean(),
      sessions: z.array(HistorySessionSchema),
    },
    "proxy_to_client",
  ),

  // PTY 语义状态，从 Envelope 迁移到 Control 层
  control("pty_state", { sessionId: IdSchema, payload: PtyStatePayloadSchema }, "proxy_to_client"),

  // Provider 语义状态，来自 Claude/Codex hook 等结构化事件，不从 PTY 字节推断
  control(
    "agent_status",
    { sessionId: IdSchema, payload: AgentStatusPayloadSchema },
    "proxy_to_client",
  ),

  // 终端标题变化，proxy -> client
  control("terminal_title", { sessionId: IdSchema, title: z.string() }, "proxy_to_client"),

  // 终端尺寸变化，proxy -> client
  control(
    "terminal_resize",
    {
      sessionId: IdSchema,
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
      // PTY output and resize events share one ordered render sequence. The client can therefore
      // place a resize between the exact byte frames that preceded and followed it.
      outputSeq: z.number().int().nonnegative(),
    },
    "proxy_to_client",
  ),
  control(
    "terminal_resize_request",
    { sessionId: IdSchema, cols: z.number().int().positive(), rows: z.number().int().positive() },
    "client_to_proxy",
  ),

  // 远程终止 JSON 会话，client -> proxy
  strictControl("session_terminate", { sessionId: IdSchema }, "client_to_proxy"),
  control(
    "session_rename",
    { ...RequestIdShape, sessionId: IdSchema, name: z.string() },
    "client_to_proxy",
  ),
  control(
    "session_rename_response",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      success: z.boolean(),
      name: z.string().optional(),
      ...RequestErrorShape,
    },
    "proxy_to_client",
  ),

  // 中断当前 turn，client -> proxy；JSON 由 session-worker 打断 Claude 子进程并保留会话。
  control("session_worker_abort", { sessionId: IdSchema }, "client_to_proxy"),

  // turn 完成信号，proxy -> client，对应 claude stream-json 的 result 事件
  control(
    "turn_result",
    {
      sessionId: IdSchema,
      success: z.boolean(),
      isError: z.boolean(),
      // stream-json result.result 是本轮最终文本。assistant_message 流丢失或 CLI 未发增量时，
      // Web 用它作为 JSON 模式兜底展示，避免 turn 已结束但界面空白。
      result: z.string().optional(),
    },
    "proxy_to_client",
  ),

  // 客户端发送到 PTY 的原始字节（ANSI 序列），不追加换行
  control(
    "remote_input_raw",
    { sessionId: IdSchema, data: z.string(), traceId: IdSchema.optional() },
    "client_to_proxy",
  ),
  // 客户端询问 proxy 的环境信息 (home 路径等), client -> proxy -> response
  // FilePathPicker 用 homePath 作为 select 模式下的默认起点, 新建会话时打开即可浏览
  controlSchema("proxy_info_request", ProxyInfoRequestSchema, "client_to_proxy"),
  controlSchema("proxy_info", ProxyInfoResponseSchema, "proxy_to_client"),
  control(
    "agent_cli_config_update",
    { ...RequestIdShape, provider: z.enum(providerValues), path: z.string().min(1) },
    "client_to_proxy",
  ),
  control(
    "agent_cli_config_update_response",
    {
      ...RequestIdShape,
      provider: z.enum(providerValues),
      agentCli: AgentCliStatusSchema.optional(),
      ...RequestErrorShape,
    },
    "proxy_to_client",
  ),

  // 远程创建会话，client -> proxy -> response。PTY 初始几何是一次性的；
  // 创建后尺寸由会话端持有，浏览器刷新、重连或换设备不重排既有内容。
  controlSchema("session_create", SessionCreateSchema, "client_to_proxy"),
  controlSchema("session_create_response", SessionCreateResponseSchema, "proxy_to_client"),

  // 会话创建响应已经成功返回、页面已进入终端后，Provider 仍可能在 bootstrap 阶段
  // 非零退出。把可识别的运行时错误结构化推给 Web，避免关键错误只留在终端闪屏里。
  control(
    "session_runtime_error",
    {
      sessionId: IdSchema,
      error: z.string(),
      errorCode: ControlErrorCodeSchema,
      activeWriterPid: z.number().int().positive().optional(),
    },
    "proxy_to_client",
  ),

  // 客户端请求会话历史消息，client -> proxy
  control(
    "session_messages_request",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      limit: z.number().int().min(1).max(200).optional(),
      before: z.string().optional(),
    },
    "client_to_proxy",
  ),

  // 客户端请求会话资源（命令列表 + 文件树），client -> proxy
  control(
    "session_resources_request",
    { ...RequiredRequestIdShape, sessionId: IdSchema },
    "client_to_proxy",
  ),
  control(
    "session_resources_response",
    {
      ...RequiredRequestIdShape,
      ...RequestErrorShape,
      sessionId: IdSchema,
      commands: z.array(CommandEntrySchema),
      groups: z.array(FileTreeGroupSchema),
    },
    "proxy_to_client",
  ),

  // 客户端请求当前 provider 语义状态；不经 relay 缓存，由 proxy 返回当前值
  control(
    "agent_status_request",
    { ...RequestIdShape, sessionId: IdSchema.optional() },
    "client_to_proxy",
  ),
  control(
    "agent_status_response",
    {
      ...RequestIdShape,
      statuses: z.array(z.object({ sessionId: IdSchema, payload: AgentStatusPayloadSchema })),
    },
    "proxy_to_client",
  ),

  // 客户端确认已收到审批请求；proxy 只记录送达状态，不把它当成用户决策
  control(
    "permission_request_delivered",
    { sessionId: IdSchema, requestId: IdSchema },
    "client_to_proxy",
  ),
  control(
    "tool_approve",
    { sessionId: IdSchema, payload: ToolApprovePayloadSchema },
    "client_to_proxy",
  ),
  control("tool_deny", { sessionId: IdSchema, payload: ToolDenyPayloadSchema }, "client_to_proxy"),

  // proxy 确认用户决策已进入 provider/worker 路径；web 用它更新审批卡片状态
  control(
    "permission_decision_result",
    {
      sessionId: IdSchema,
      requestId: IdSchema,
      outcome: z.enum(["allow", "deny"]),
      delivered: z.boolean(),
      message: z.string().optional(),
    },
    "proxy_to_client",
  ),

  // proxy 推送当前 pending 的工具审批列表，client 据此恢复审批卡片
  control(
    "pending_approvals_push",
    {
      sessionId: IdSchema,
      approvals: z.array(
        z.object({
          requestId: IdSchema,
          toolName: z.string(),
          input: z.record(z.string(), z.unknown()),
          options: z.array(ApprovalOptionSchema).optional(),
        }),
      ),
    },
    "proxy_to_client",
  ),

  // Voice Pilot speech summaries are produced by proxy-side Claude Code so it can read project context.
  control(
    "voice_summary_request",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      messageId: IdSchema,
      text: z.string().min(1),
      reason: VoiceSummaryReasonSchema,
    },
    "client_to_proxy",
  ),
  control(
    "voice_summary_response",
    {
      ...RequestIdShape,
      ...RequestErrorShape,
      sessionId: IdSchema,
      messageId: IdSchema,
      success: z.boolean(),
      summary: z.string().min(1).optional(),
    },
    "proxy_to_client",
  ),

  // 恢复会话时推送历史消息，proxy -> client
  control(
    "session_history_messages",
    {
      ...RequestIdShape,
      sessionId: IdSchema,
      before: z.string().optional(),
      messages: z.array(SessionHistoryMessageSchema),
      hasMore: z.boolean().optional(),
      nextBefore: z.string().optional(),
    },
    "proxy_to_client",
  ),

  // proxy 重连后同步活跃 session 列表给 relay。session_sync 由 relay 自消费（更新 proxy-session
  // 关联）不转发给 client，因此**没有** direction 标注——RelayControlDirection 只描述转发流。
  control("session_sync", {
    sessions: z.array(
      createSessionIdentitySchema({
        id: z.string(),
        cwd: z.string(),
        name: z.string().optional(),
        nameLocked: z.boolean().optional(),
        state: z.enum(sessionStateValues),
      }),
    ),
  }),

  // PTY 会话订阅，client -> proxy，触发 terminal serialize() 返回当前状态
  control("session_subscribe", { sessionId: IdSchema, requestId: IdSchema }, "client_to_proxy"),

  // PTY 会话快照，proxy -> client，serialize() 的全量终端状态
  control(
    "session_snapshot",
    {
      sessionId: IdSchema,
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
      data: z.string(),
      outputSeq: z.number().int().nonnegative(),
      requestId: IdSchema,
    },
    "proxy_to_client",
  ),
] as const;

const relayControlSchemas = relayControlDefinitions.map((definition) => definition.schema) as [
  (typeof relayControlDefinitions)[number]["schema"],
  ...Array<(typeof relayControlDefinitions)[number]["schema"]>,
];

export const RelayControlSchema = z.discriminatedUnion("type", relayControlSchemas);

export type RelayControlMessage = z.infer<typeof RelayControlSchema>;
export type RelayControlType = RelayControlMessage["type"];

export const ProxyToClientRelayControlTypes = new Set(
  relayControlDefinitions
    .filter((definition) => definition.directions.has("proxy_to_client"))
    .map((definition) => definition.type),
);

export function isProxyToClientRelayControlType(type: RelayControlType): boolean {
  return ProxyToClientRelayControlTypes.has(type);
}

export const ClientToProxyRelayControlTypes = new Set(
  relayControlDefinitions
    .filter((definition) => definition.directions.has("client_to_proxy"))
    .map((definition) => definition.type),
);

export function isClientToProxyRelayControlType(type: RelayControlType): boolean {
  return ClientToProxyRelayControlTypes.has(type);
}
