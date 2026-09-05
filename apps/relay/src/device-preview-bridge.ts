import type { Request, Response } from "express";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import {
  ControlErrorCode,
  DEVICE_PREVIEW_FRAME_MAX_BYTES,
  DEVICE_PREVIEW_H264_PACKET_SENTINEL,
  DevicePreviewStreamRegisterSchema,
  RelayCloseCode,
  decodeDevicePreviewFrame,
  decodeDevicePreviewH264ProxyPacket,
  encodeDevicePreviewH264HttpPacket,
  encodeDevicePreviewHttpFrame,
  serializeControl,
  type ControlMessage,
  type ControlErrorCodeType,
  type DevicePreviewStreamProfile,
  type DevicePreviewStreamFormat,
  type DevicePreviewH264Packet,
  type DevicePreviewStreamStopReason,
  type RelayControlMessage,
} from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { RelayChaos } from "./chaos.js";
import {
  DevicePreviewRouteRegistry,
  devicePreviewResponseByRequest,
  isDevicePreviewRequestMessage,
  isDevicePreviewResponseMessage,
  type DevicePreviewRequestMessage,
  type DevicePreviewResponseMessage,
} from "./device-preview-route-registry.js";
import type { RelayRegistry } from "./registry.js";
import { rewriteForwardedControl } from "./forwarded-control.js";

const DEFAULT_TOKEN_TTL_MS = 20_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 20_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_REGISTER_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STREAMS = 64;
const DEFAULT_MAX_STREAMS_PER_PROXY = 8;
const DEFAULT_MAX_STREAMS_PER_CLIENT = 2;
const DEFAULT_MAX_STREAMS_PER_PREVIEW = 3;
const DEFAULT_MAX_INPUTS_PER_SECOND = 120;
const DEFAULT_MAX_OUTSTANDING_INPUTS_PER_LEASE = 32;
const STREAM_CONTENT_TYPE = "application/x-dev-anywhere-device-preview";
const MAX_BUFFERED_STARTING_H264_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_STARTING_H264_PACKETS = 512;

type H264SyncState = "awaiting_configuration" | "awaiting_keyframe" | "synced";
type StreamWriteResult = "writable" | "backpressured" | "failed";

type ClientSocket = WebSocket & {
  clientId?: string;
  boundProxyId?: string;
  bindingId?: string;
};
type StreamTransportSocket = WebSocket & {
  isAlive?: boolean;
  devicePreviewProxyId?: string;
  devicePreviewConnectionId?: string;
};

interface ProxyConnection {
  proxyWs: WebSocket;
  connectionId: string;
}

interface StreamTransport {
  ws: StreamTransportSocket;
  proxyId: string;
  connectionId: string;
}

interface ControlLease {
  leaseId: string;
  clientId: string;
  clientWs: ClientSocket;
  proxyId: string;
  bindingId: string;
  proxyWs: WebSocket;
  previewId: string;
  controller: boolean;
  streamId?: string;
  token?: string;
  lastInputSeq: number;
  rateWindowStartedAt: number;
  inputCount: number;
  outstandingInputSeqs: Set<number>;
}

interface StreamToken {
  token: string;
  leaseId: string;
  profile: DevicePreviewStreamProfile;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface BufferedStartingFrame {
  sequence: number;
  jpeg: Uint8Array;
}

interface BufferedStartingH264Packet extends DevicePreviewH264Packet {
  annexB: Uint8Array;
}

interface BufferedStartingH264State {
  configuration: BufferedStartingH264Packet;
  packets: BufferedStartingH264Packet[];
  totalBytes: number;
  hasKeyframe: boolean;
}

interface ActiveStream {
  streamId: string;
  lease: ControlLease;
  transport: StreamTransport;
  res: Response;
  state: "starting" | "streaming";
  startTimer: ReturnType<typeof setTimeout>;
  firstFrameTimer: ReturnType<typeof setTimeout> | null;
  headersSent: boolean;
  finished: boolean;
  paused: boolean;
  requestedFormat: DevicePreviewStreamFormat;
  format?: DevicePreviewStreamFormat;
  h264SyncState: H264SyncState;
  h264DroppedWhilePaused: boolean;
  lastFrameSequence: number | null;
  bufferedStartingFrame?: BufferedStartingFrame;
  bufferedStartingH264?: BufferedStartingH264State;
  drainListener?: () => void;
  drainTimer?: ReturnType<typeof setTimeout>;
}

interface DevicePreviewBridgeOptions {
  registry: RelayRegistry;
  logger: Logger;
  chaos?: RelayChaos;
  clientTokenRequired?: boolean;
  validateClientToken?: (token: string | null) => boolean;
  tokenTtlMs?: number;
  startTimeoutMs?: number;
  firstFrameTimeoutMs?: number;
  drainTimeoutMs?: number;
  registerTimeoutMs?: number;
  maxStreams?: number;
  maxStreamsPerProxy?: number;
  maxStreamsPerClient?: number;
  maxStreamsPerPreview?: number;
  maxInputsPerSecond?: number;
  maxOutstandingInputsPerLease?: number;
  now?: () => number;
  tokenFactory?: () => string;
  idFactory?: () => string;
}

function bearerToken(header: string | undefined): string | null {
  return /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? null;
}

function previewKey(proxyId: string, previewId: string): string {
  return JSON.stringify([proxyId, previewId]);
}

function streamErrorStatus(errorCode?: string): number {
  switch (errorCode) {
    case ControlErrorCode.PROXY_OFFLINE:
    case ControlErrorCode.PROXY_NOT_FOUND:
      return 502;
    case ControlErrorCode.STREAM_CAPACITY_EXCEEDED:
      return 429;
    default:
      return 502;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DevicePreviewBridge {
  private readonly routes = new DevicePreviewRouteRegistry();
  private readonly proxyConnections = new Map<string, ProxyConnection>();
  private readonly transports = new Map<string, StreamTransport>();
  private readonly tokens = new Map<string, StreamToken>();
  private readonly leases = new Map<string, ControlLease>();
  private readonly controllerByPreview = new Map<string, string>();
  private readonly streams = new Map<string, ActiveStream>();
  private readonly tokenTtlMs: number;
  private readonly startTimeoutMs: number;
  private readonly firstFrameTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly registerTimeoutMs: number;
  private readonly maxStreams: number;
  private readonly maxStreamsPerProxy: number;
  private readonly maxStreamsPerClient: number;
  private readonly maxStreamsPerPreview: number;
  private readonly maxInputsPerSecond: number;
  private readonly maxOutstandingInputsPerLease: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly idFactory: () => string;
  private disposed = false;

  constructor(private readonly options: DevicePreviewBridgeOptions) {
    this.tokenTtlMs = Math.max(1, options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS);
    this.startTimeoutMs = Math.max(1, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    this.firstFrameTimeoutMs = Math.max(
      1,
      options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    );
    this.drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    this.registerTimeoutMs = Math.max(1, options.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS);
    this.maxStreams = Math.max(1, options.maxStreams ?? DEFAULT_MAX_STREAMS);
    this.maxStreamsPerProxy = Math.max(
      1,
      options.maxStreamsPerProxy ?? DEFAULT_MAX_STREAMS_PER_PROXY,
    );
    this.maxStreamsPerClient = Math.max(
      1,
      options.maxStreamsPerClient ?? DEFAULT_MAX_STREAMS_PER_CLIENT,
    );
    this.maxStreamsPerPreview = Math.max(
      1,
      options.maxStreamsPerPreview ?? DEFAULT_MAX_STREAMS_PER_PREVIEW,
    );
    this.maxInputsPerSecond = Math.max(
      1,
      options.maxInputsPerSecond ?? DEFAULT_MAX_INPUTS_PER_SECOND,
    );
    this.maxOutstandingInputsPerLease = Math.max(
      1,
      options.maxOutstandingInputsPerLease ?? DEFAULT_MAX_OUTSTANDING_INPUTS_PER_LEASE,
    );
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? (() => nanoid(32));
    this.idFactory = options.idFactory ?? (() => nanoid(21));
  }

  /** Called for every successful main `/proxy` registration; returns a per-connection nonce. */
  registerProxyConnection(proxyId: string, proxyWs: WebSocket): string {
    this.clearProxyRuntime(proxyId, "proxy_offline", false);
    const connectionId = this.idFactory();
    this.proxyConnections.set(proxyId, { proxyWs, connectionId });
    return connectionId;
  }

  handleStreamTransportConnection(ws: WebSocket): void {
    const transportWs = ws as StreamTransportSocket;
    transportWs.isAlive = true;
    let registered: StreamTransport | null = null;
    const registerTimer = setTimeout(() => {
      if (!registered && transportWs.readyState === WebSocket.OPEN) {
        transportWs.close(
          RelayCloseCode.DEVICE_STREAM_PROTOCOL_REJECTED,
          "device stream registration timeout",
        );
      }
    }, this.registerTimeoutMs);
    registerTimer.unref?.();

    transportWs.on("pong", () => {
      transportWs.isAlive = true;
    });
    transportWs.on("message", (data: Buffer, isBinary: boolean) => {
      if (!registered) {
        if (isBinary || data.length > 8 * 1024) {
          this.rejectTransport(transportWs, "device stream must register before sending frames");
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          this.rejectTransport(transportWs, "invalid device stream registration JSON");
          return;
        }
        const parsed = DevicePreviewStreamRegisterSchema.safeParse(raw);
        if (!parsed.success) {
          this.rejectTransport(transportWs, "invalid device stream registration");
          return;
        }
        const current = this.proxyConnections.get(parsed.data.proxyId);
        if (
          !current ||
          current.connectionId !== parsed.data.connectionId ||
          current.proxyWs !== this.options.registry.getProxy(parsed.data.proxyId) ||
          current.proxyWs.readyState !== WebSocket.OPEN
        ) {
          transportWs.send(
            JSON.stringify({
              type: "device_preview_stream_register_response",
              success: false,
              error: "stale or unknown Proxy connection",
            }),
          );
          transportWs.close(
            RelayCloseCode.DEVICE_STREAM_BINDING_REJECTED,
            "device stream binding rejected",
          );
          return;
        }
        const prior = this.transports.get(parsed.data.proxyId);
        if (prior && prior.ws !== transportWs) {
          // A second transport for the same main Proxy generation supersedes the first one. Stop
          // its viewers through the still-live control socket before dropping the data socket, so
          // Proxy capture jobs cannot survive with nowhere valid to publish.
          this.failStreamsForTransport(prior, "设备画面连接已被替换");
          this.transports.delete(parsed.data.proxyId);
          prior.ws.terminate();
        }
        registered = {
          ws: transportWs,
          proxyId: parsed.data.proxyId,
          connectionId: parsed.data.connectionId,
        };
        transportWs.devicePreviewProxyId = parsed.data.proxyId;
        transportWs.devicePreviewConnectionId = parsed.data.connectionId;
        this.transports.set(parsed.data.proxyId, registered);
        clearTimeout(registerTimer);
        transportWs.send(
          JSON.stringify({ type: "device_preview_stream_register_response", success: true }),
        );
        this.options.logger.info(
          { proxyId: parsed.data.proxyId },
          "Device preview stream transport registered",
        );
        return;
      }

      if (!isBinary) {
        this.rejectTransport(transportWs, "unexpected device stream transport message");
        return;
      }
      if (data.length > DEVICE_PREVIEW_FRAME_MAX_BYTES + 512) {
        this.options.logger.warn(
          { proxyId: registered.proxyId, bytes: data.length },
          "Oversized device preview frame dropped",
        );
        return;
      }
      const h264Packet =
        data[0] === DEVICE_PREVIEW_H264_PACKET_SENTINEL
          ? decodeDevicePreviewH264ProxyPacket(data)
          : null;
      if (h264Packet) {
        this.handleH264Packet(registered, h264Packet.streamId, h264Packet);
        return;
      }
      const frame = decodeDevicePreviewFrame(data);
      if (!frame) {
        this.options.logger.warn(
          { proxyId: registered.proxyId, bytes: data.length },
          "Malformed device preview frame dropped",
        );
        return;
      }
      this.handleFrame(registered, frame.streamId, frame.frameSequence, frame.jpeg);
    });

    transportWs.on("close", () => {
      clearTimeout(registerTimer);
      if (!registered || this.transports.get(registered.proxyId)?.ws !== transportWs) return;
      this.transports.delete(registered.proxyId);
      this.failStreamsForTransport(registered, "设备画面连接已断开");
      this.options.logger.info(
        { proxyId: registered.proxyId },
        "Device preview stream transport disconnected",
      );
    });
    transportWs.on("error", (error) => {
      this.options.logger.warn(
        { proxyId: registered?.proxyId, error: errorText(error) },
        "Device preview stream transport error",
      );
    });
  }

  handleClientControl(clientWs: WebSocket, message: RelayControlMessage): boolean {
    const socket = clientWs as ClientSocket;
    if (isDevicePreviewRequestMessage(message)) {
      this.forwardManagementRequest(socket, message);
      return true;
    }
    switch (message.type) {
      case "device_preview_stream_url_request":
        this.issueStreamUrl(socket, message);
        return true;
      case "device_preview_input":
        this.forwardInput(socket, message);
        return true;
      case "device_preview_control_claim_request":
        this.claimControl(socket, message);
        return true;
      default:
        return false;
    }
  }

  handleProxyControl(
    proxyId: string,
    proxyWs: WebSocket,
    message: RelayControlMessage,
    raw: string,
  ): boolean {
    if (!this.isCurrentProxyConnection(proxyId, proxyWs)) return this.isDeviceMessage(message);
    if (isDevicePreviewResponseMessage(message)) {
      this.resolveManagementResponse(proxyId, proxyWs, message, raw);
      return true;
    }
    switch (message.type) {
      case "device_preview_stream_start_response":
        this.handleStreamStartResponse(proxyId, message);
        return true;
      case "device_preview_stream_complete":
        this.handleStreamComplete(proxyId, message);
        return true;
      case "device_preview_input_ack":
        this.handleInputAck(proxyId, message, raw);
        return true;
      default:
        // Every device_preview_* message has an explicit Relay-owned route. Never let an
        // unexpected or locally-generated variant fall through to generic Proxy broadcasting.
        return this.isDeviceMessage(message);
    }
  }

  handlePreviewRemovedEvent(proxyId: string, proxyWs: WebSocket, previewId: string): void {
    if (!this.isCurrentProxyConnection(proxyId, proxyWs)) return;
    this.stopPreviewStreams(proxyId, previewId, "preview_closed");
  }

  handleHttpRequest(req: Request, res: Response): void {
    // Tokens and their validity are private, short-lived state; never let an intermediary cache
    // either successful streams or authentication/expiry responses.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (
      this.options.clientTokenRequired &&
      !this.options.validateClientToken?.(bearerToken(req.get("authorization")))
    ) {
      res.status(401).json({ error: "invalid_client_token" });
      return;
    }

    const tokenValue = req.params.token;
    const token = typeof tokenValue === "string" ? this.tokens.get(tokenValue) : undefined;
    if (!token || token.expiresAt <= this.now()) {
      if (token) this.expireToken(token);
      res.status(404).json({ error: "device_preview_stream_url_expired" });
      return;
    }

    // Single-use is atomic: remove the bearer before any Proxy lookup or asynchronous operation.
    this.tokens.delete(token.token);
    clearTimeout(token.timer);
    const lease = this.leases.get(token.leaseId);
    if (!lease || lease.token !== token.token || !this.clientLeaseStillValid(lease)) {
      if (lease) this.releaseLease(lease, "lease_expired", true);
      res.status(410).json({ error: "device_preview_stream_lease_expired" });
      return;
    }
    lease.token = undefined;

    const transport = this.transports.get(lease.proxyId);
    const connection = this.proxyConnections.get(lease.proxyId);
    if (
      !transport ||
      transport.ws.readyState !== WebSocket.OPEN ||
      !connection ||
      connection.proxyWs !== lease.proxyWs ||
      transport.connectionId !== connection.connectionId
    ) {
      this.releaseLease(lease, "proxy_offline", true);
      res.status(502).json({ error: "device_preview_stream_transport_offline" });
      return;
    }

    let streamId: string;
    try {
      streamId = this.allocateUniqueRuntimeId(this.streams, "stream");
    } catch (error) {
      this.options.logger.error(
        { proxyId: lease.proxyId, previewId: lease.previewId, error: errorText(error) },
        "Could not allocate Device Preview stream ID",
      );
      this.releaseLease(lease, "stream_closed", true);
      res.status(503).json({ error: "device_preview_stream_id_unavailable" });
      return;
    }
    const startTimer = setTimeout(() => {
      this.failStream(streamId, 504, "等待设备画面超时", "stream_error");
    }, this.startTimeoutMs);
    startTimer.unref?.();
    const stream: ActiveStream = {
      streamId,
      lease,
      transport,
      res,
      state: "starting",
      startTimer,
      firstFrameTimer: null,
      headersSent: false,
      finished: false,
      paused: false,
      requestedFormat: token.profile.format,
      h264SyncState: "awaiting_configuration",
      h264DroppedWhilePaused: false,
      lastFrameSequence: null,
    };
    lease.streamId = streamId;
    this.streams.set(streamId, stream);

    res.on("close", () => {
      if (stream.finished) return;
      this.finishStream(stream, "client_closed", true, "设备画面连接已关闭");
    });

    const profile = token.profile;
    const startMessage = serializeControl({
      type: "device_preview_stream_start",
      streamId,
      leaseId: lease.leaseId,
      previewId: lease.previewId,
      format: profile.format,
      ...(profile.format === "jpeg" && profile.maxFps !== undefined
        ? { maxFps: profile.maxFps }
        : {}),
    });
    try {
      lease.proxyWs.send(startMessage, (error) => {
        if (error) this.failStream(streamId, 502, "无法向开发机启动设备画面");
      });
    } catch (error) {
      this.failStream(streamId, 502, errorText(error));
      return;
    }
    this.options.logger.info(
      { streamId, proxyId: lease.proxyId, previewId: lease.previewId },
      "Device preview HTTP stream requested",
    );
  }

  abandonClientSocket(clientWs: WebSocket): void {
    this.routes.abandonSocket(clientWs);
    for (const lease of [...this.leases.values()]) {
      if (lease.clientWs !== clientWs) continue;
      const stream = lease.streamId ? this.streams.get(lease.streamId) : undefined;
      if (stream) this.finishStream(stream, "client_closed", true, "客户端已断开");
      else this.releaseLease(lease, "lease_expired", false);
    }
  }

  clearProxy(proxyId: string): void {
    this.clearProxyRuntime(proxyId, "proxy_offline", true);
    this.proxyConnections.delete(proxyId);
  }

  revokeProxy(proxyId: string): void {
    this.clearProxy(proxyId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.routes.dispose();
    for (const stream of [...this.streams.values()]) {
      this.finishStream(stream, "relay_shutdown", true, "Relay 正在停止");
    }
    for (const token of [...this.tokens.values()]) this.expireToken(token);
    for (const transport of this.transports.values()) transport.ws.terminate();
    this.transports.clear();
    this.proxyConnections.clear();
  }

  private forwardManagementRequest(
    clientWs: ClientSocket,
    message: DevicePreviewRequestMessage,
  ): void {
    if (!clientWs.clientId) {
      if (
        !this.sendManagementFailure(
          clientWs,
          message,
          "客户端未注册",
          ControlErrorCode.PROXY_OFFLINE,
        )
      ) {
        this.sendRelayError(clientWs, message.requestId, "NOT_REGISTERED", "客户端未注册");
      }
      return;
    }
    const proxyId = clientWs.boundProxyId;
    if (!proxyId) {
      if (
        !this.sendManagementFailure(
          clientWs,
          message,
          "当前未连接开发机",
          ControlErrorCode.PROXY_OFFLINE,
        )
      ) {
        this.sendRelayError(clientWs, message.requestId, "NOT_BOUND", "当前未连接开发机");
      }
      return;
    }
    const proxyWs = this.options.registry.getProxy(proxyId);
    if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
      if (
        !this.sendManagementFailure(
          clientWs,
          message,
          "当前开发机不在线",
          ControlErrorCode.PROXY_OFFLINE,
        )
      ) {
        this.sendRelayError(clientWs, message.requestId, "PROXY_OFFLINE", "当前开发机不在线");
      }
      return;
    }
    let registration: ReturnType<DevicePreviewRouteRegistry["register"]>;
    try {
      registration = this.routes.register(
        proxyId,
        message.requestId,
        devicePreviewResponseByRequest[message.type],
        clientWs,
        proxyWs,
      );
    } catch (error) {
      this.options.logger.error(
        { proxyId, type: message.type, error: errorText(error) },
        "Could not allocate Device Preview management route",
      );
      if (
        !this.sendManagementFailure(
          clientWs,
          message,
          "暂时无法处理设备预览请求",
          ControlErrorCode.UNKNOWN,
        )
      ) {
        this.sendRelayError(
          clientWs,
          message.requestId,
          "INVALID_MESSAGE",
          "暂时无法处理设备预览请求",
        );
      }
      return;
    }
    if (registration.kind !== "registered") {
      const error =
        registration.kind === "client_capacity_exceeded"
          ? "当前客户端有过多待处理的设备预览请求"
          : "设备预览请求过多";
      if (!this.sendManagementFailure(clientWs, message, error, ControlErrorCode.RATE_LIMITED)) {
        this.sendRelayError(clientWs, message.requestId, "INVALID_MESSAGE", error);
      }
      return;
    }
    const upstream = {
      ...message,
      requestId: registration.upstreamRequestId,
    } as DevicePreviewRequestMessage;
    const requestRouteStillCurrent = (): boolean =>
      clientWs.readyState === WebSocket.OPEN &&
      proxyWs.readyState === WebSocket.OPEN &&
      this.options.registry.getProxy(proxyId) === proxyWs &&
      this.options.registry.isCurrentClientBinding(clientWs.clientId, clientWs, message.scope);
    this.sendProxy(proxyWs, serializeControl(upstream), message.type, requestRouteStillCurrent);
  }

  private sendManagementFailure(
    clientWs: ClientSocket,
    message: DevicePreviewRequestMessage,
    error: string,
    errorCode: ControlErrorCodeType,
  ): boolean {
    switch (message.type) {
      case "device_preview_capability_request":
        this.sendClient(
          clientWs,
          serializeControl({
            type: "device_preview_capability_response",
            requestId: message.requestId,
            scope: message.scope,
            success: false,
            error,
            errorCode,
          }),
          "device_preview_capability_response",
        );
        return true;
      case "device_preview_targets_request":
        this.sendClient(
          clientWs,
          serializeControl({
            type: "device_preview_targets_response",
            requestId: message.requestId,
            scope: message.scope,
            success: false,
            error,
            errorCode,
          }),
          "device_preview_targets_response",
        );
        return true;
      case "device_preview_create_request":
        this.sendClient(
          clientWs,
          serializeControl({
            type: "device_preview_create_response",
            requestId: message.requestId,
            scope: message.scope,
            operationId: message.operationId,
            accepted: false,
            error,
            errorCode,
          }),
          "device_preview_create_response",
        );
        return true;
      case "device_preview_rename_request":
        this.sendClient(
          clientWs,
          serializeControl({
            type: "device_preview_rename_response",
            requestId: message.requestId,
            scope: message.scope,
            operationId: message.operationId,
            previewId: message.previewId,
            success: false,
            error,
            errorCode,
          }),
          "device_preview_rename_response",
        );
        return true;
      case "device_preview_reconnect_request":
        this.sendClient(
          clientWs,
          serializeControl({
            type: "device_preview_reconnect_response",
            requestId: message.requestId,
            scope: message.scope,
            operationId: message.operationId,
            previewId: message.previewId,
            success: false,
            error,
            errorCode,
          }),
          "device_preview_reconnect_response",
        );
        return true;
      case "device_preview_close_request":
        this.sendClient(
          clientWs,
          serializeControl({
            type: "device_preview_close_response",
            requestId: message.requestId,
            scope: message.scope,
            operationId: message.operationId,
            previewId: message.previewId,
            success: false,
            error,
            errorCode,
          }),
          "device_preview_close_response",
        );
        return true;
      case "device_preview_list_request":
        return false;
    }
  }

  private resolveManagementResponse(
    proxyId: string,
    proxyWs: WebSocket,
    message: DevicePreviewResponseMessage,
    raw: string,
  ): void {
    if (message.type === "device_preview_close_response" && message.success) {
      // The current Proxy's authoritative resource cleanup applies even if the requesting
      // browser disconnected and its exact response route has become a tombstone.
      this.stopPreviewStreams(proxyId, message.previewId, "preview_closed");
    }
    const route = this.routes.resolve(proxyId, message.requestId, message.type, proxyWs);
    if (route.kind !== "matched") {
      this.options.logger.debug(
        { proxyId, requestId: message.requestId, type: message.type, route: route.kind },
        "Unmatched Device Preview response dropped",
      );
      return;
    }
    const isCurrentRoute = (): boolean =>
      this.isCurrentProxyConnection(proxyId, proxyWs) &&
      this.options.registry.isCurrentClientBinding(route.clientId, route.clientWs, route.scope);
    if (route.clientWs.readyState !== WebSocket.OPEN || !isCurrentRoute()) return;
    const response = rewriteForwardedControl(raw, {
      type: message.type,
      requestId: route.clientRequestId,
      scope: route.scope,
    });
    this.sendClient(route.clientWs, response, message.type, isCurrentRoute);
  }

  private issueStreamUrl(
    clientWs: ClientSocket,
    message: ControlMessage<"device_preview_stream_url_request">,
  ): void {
    const requestBindingStillCurrent = (): boolean =>
      this.options.registry.isCurrentClientBinding(clientWs.clientId, clientWs, message.scope);
    const failure = (
      error: string,
      errorCode: ControlErrorCodeType = ControlErrorCode.UNKNOWN,
    ): void => {
      this.sendClient(
        clientWs,
        serializeControl({
          type: "device_preview_stream_url_response",
          requestId: message.requestId,
          scope: message.scope,
          previewId: message.previewId,
          success: false,
          error,
          errorCode,
        }),
        "device_preview_stream_url_response",
        requestBindingStillCurrent,
      );
    };
    if (!clientWs.clientId) {
      failure("客户端未注册", ControlErrorCode.CONTROL_LEASE_INVALID);
      return;
    }
    const proxyId = clientWs.boundProxyId;
    const proxyWs = proxyId ? this.options.registry.getProxy(proxyId) : undefined;
    if (!proxyId || !proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
      failure("当前开发机不在线", ControlErrorCode.PROXY_OFFLINE);
      return;
    }
    const connection = this.proxyConnections.get(proxyId);
    const transport = this.transports.get(proxyId);
    if (
      !connection ||
      connection.proxyWs !== proxyWs ||
      !transport ||
      transport.connectionId !== connection.connectionId ||
      transport.ws.readyState !== WebSocket.OPEN
    ) {
      failure("设备画面连接尚未就绪", ControlErrorCode.PROCESS_START_FAILED);
      return;
    }
    this.cleanupExpiredTokens();
    // A component may unmount after requesting a URL but before receiving/consuming it. A retry
    // for the same browser socket and preview supersedes only that unconsumed token; active HTTP
    // streams are deliberately untouched.
    for (const oldLease of [...this.leases.values()]) {
      if (
        oldLease.clientWs === clientWs &&
        oldLease.proxyId === proxyId &&
        oldLease.previewId === message.previewId &&
        oldLease.token !== undefined &&
        oldLease.streamId === undefined
      ) {
        this.releaseLease(oldLease, "lease_expired", false);
      }
    }
    if (!this.hasLeaseCapacity(clientWs.clientId, proxyId, message.previewId)) {
      failure("同时打开的设备画面过多", ControlErrorCode.STREAM_CAPACITY_EXCEEDED);
      return;
    }

    let leaseId: string;
    let tokenValue: string;
    try {
      leaseId = this.allocateUniqueRuntimeId(this.leases, "lease");
      tokenValue = this.allocateUniqueToken();
    } catch (error) {
      this.options.logger.error(
        { proxyId, previewId: message.previewId, error: errorText(error) },
        "Could not allocate Device Preview stream token",
      );
      failure("暂时无法创建设备画面链接");
      return;
    }
    const key = previewKey(proxyId, message.previewId);
    const controller = !this.controllerByPreview.has(key);
    const lease: ControlLease = {
      leaseId,
      clientId: clientWs.clientId,
      clientWs,
      proxyId,
      bindingId: message.scope.bindingId,
      proxyWs,
      previewId: message.previewId,
      controller,
      lastInputSeq: -1,
      rateWindowStartedAt: this.now(),
      inputCount: 0,
      outstandingInputSeqs: new Set(),
    };
    if (controller) this.controllerByPreview.set(key, leaseId);
    const expiresAt = this.now() + this.tokenTtlMs;
    const timer = setTimeout(() => {
      const token = this.tokens.get(tokenValue);
      if (token) this.expireToken(token);
    }, this.tokenTtlMs);
    timer.unref?.();
    const token: StreamToken = {
      token: tokenValue,
      leaseId,
      profile: message.profile,
      expiresAt,
      timer,
    };
    lease.token = tokenValue;
    this.leases.set(leaseId, lease);
    this.tokens.set(tokenValue, token);
    this.sendClient(
      clientWs,
      serializeControl({
        type: "device_preview_stream_url_response",
        requestId: message.requestId,
        scope: message.scope,
        previewId: message.previewId,
        success: true,
        url: `/api/device-preview-streams/${tokenValue}`,
        leaseId,
        expiresAt,
        controlMode: controller ? "controller" : "view_only",
      }),
      "device_preview_stream_url_response",
      () => this.leases.get(lease.leaseId) === lease && this.clientLeaseStillValid(lease),
    );
  }

  private forwardInput(
    clientWs: ClientSocket,
    message: ControlMessage<"device_preview_input">,
  ): void {
    const requestBindingStillCurrent = (): boolean =>
      this.options.registry.isCurrentClientBinding(clientWs.clientId, clientWs, message.scope);
    const lease = this.leases.get(message.leaseId);
    const reject = (
      error: string,
      errorCode: ControlErrorCodeType = ControlErrorCode.CONTROL_LEASE_INVALID,
    ): void => {
      this.sendClient(
        clientWs,
        serializeControl({
          type: "device_preview_input_ack",
          scope: message.scope,
          leaseId: message.leaseId,
          inputSeq: message.inputSeq,
          success: false,
          error,
          errorCode,
        }),
        "device_preview_input_ack",
        requestBindingStillCurrent,
      );
    };
    const inputStillAuthorized = (): boolean => {
      if (!lease) return false;
      const streamId = lease.streamId;
      return (
        message.scope.proxyId === lease.proxyId &&
        message.scope.bindingId === lease.bindingId &&
        lease.clientWs === clientWs &&
        this.leases.get(lease.leaseId) === lease &&
        lease.controller &&
        streamId !== undefined &&
        this.streams.get(streamId)?.lease === lease &&
        lease.outstandingInputSeqs.has(message.inputSeq) &&
        this.clientLeaseStillValid(lease)
      );
    };
    if (
      !lease ||
      lease.clientWs !== clientWs ||
      !lease.controller ||
      !lease.streamId ||
      this.streams.get(lease.streamId)?.lease !== lease ||
      !this.clientLeaseStillValid(lease)
    ) {
      reject("设备控制权已失效");
      return;
    }
    if (message.inputSeq <= lease.lastInputSeq) {
      reject("设备输入序号已过期");
      return;
    }
    if (lease.outstandingInputSeqs.size >= this.maxOutstandingInputsPerLease) {
      reject("设备输入队列已满", ControlErrorCode.RATE_LIMITED);
      return;
    }
    const now = this.now();
    if (now - lease.rateWindowStartedAt >= 1_000) {
      lease.rateWindowStartedAt = now;
      lease.inputCount = 0;
    }
    if (lease.inputCount >= this.maxInputsPerSecond) {
      reject("设备输入过于频繁", ControlErrorCode.RATE_LIMITED);
      return;
    }
    lease.inputCount += 1;
    lease.lastInputSeq = message.inputSeq;
    lease.outstandingInputSeqs.add(message.inputSeq);
    this.sendProxy(lease.proxyWs, serializeControl(message), message.type, inputStillAuthorized);
  }

  private claimControl(
    clientWs: ClientSocket,
    message: ControlMessage<"device_preview_control_claim_request">,
  ): void {
    const requestBindingStillCurrent = (): boolean =>
      this.options.registry.isCurrentClientBinding(clientWs.clientId, clientWs, message.scope);
    const lease = this.leases.get(message.leaseId);
    if (
      !lease ||
      lease.clientWs !== clientWs ||
      !lease.streamId ||
      !this.streams.has(lease.streamId) ||
      !this.clientLeaseStillValid(lease)
    ) {
      this.sendClient(
        clientWs,
        serializeControl({
          type: "device_preview_control_claim_response",
          requestId: message.requestId,
          scope: message.scope,
          leaseId: message.leaseId,
          success: false,
          error: "设备画面已失效",
          errorCode: ControlErrorCode.CONTROL_LEASE_INVALID,
        }),
        "device_preview_control_claim_response",
        requestBindingStillCurrent,
      );
      return;
    }

    const key = previewKey(lease.proxyId, lease.previewId);
    const oldControllerId = this.controllerByPreview.get(key);
    if (oldControllerId && oldControllerId !== lease.leaseId) {
      const old = this.leases.get(oldControllerId);
      if (old) {
        const revokeSent = this.sendProxyInternal(
          old.proxyWs,
          serializeControl({
            type: "device_preview_input_revoke",
            leaseId: old.leaseId,
            reason: "control_taken_over",
          }),
        );
        if (!revokeSent) {
          this.sendClient(
            clientWs,
            serializeControl({
              type: "device_preview_control_claim_response",
              requestId: message.requestId,
              scope: message.scope,
              leaseId: message.leaseId,
              success: false,
              error: "开发机连接已断开",
              errorCode: ControlErrorCode.PROXY_OFFLINE,
            }),
            "device_preview_control_claim_response",
            requestBindingStillCurrent,
          );
          return;
        }
        old.controller = false;
        old.rateWindowStartedAt = this.now();
        old.inputCount = 0;
        for (const inputSeq of old.outstandingInputSeqs) {
          this.sendClient(
            old.clientWs,
            serializeControl({
              type: "device_preview_input_ack",
              scope: { proxyId: old.proxyId, bindingId: old.bindingId },
              leaseId: old.leaseId,
              inputSeq,
              success: false,
              error: "设备控制权已被其他客户端接管",
              errorCode: ControlErrorCode.CONTROL_LEASE_INVALID,
            }),
            "device_preview_input_ack",
            () =>
              this.leases.get(old.leaseId) === old &&
              !old.controller &&
              this.clientBindingStillMatches(old),
          );
        }
        old.outstandingInputSeqs.clear();
        this.sendControlRevoked(old, "taken_over");
      }
    }
    lease.controller = true;
    this.controllerByPreview.set(key, lease.leaseId);
    this.sendClient(
      clientWs,
      serializeControl({
        type: "device_preview_control_claim_response",
        requestId: message.requestId,
        scope: message.scope,
        leaseId: lease.leaseId,
        success: true,
        controlMode: "controller",
      }),
      "device_preview_control_claim_response",
      () =>
        this.leases.get(lease.leaseId) === lease &&
        lease.controller &&
        this.clientLeaseStillValid(lease),
    );
  }

  private handleStreamStartResponse(
    proxyId: string,
    message: ControlMessage<"device_preview_stream_start_response">,
  ): void {
    const stream = this.streams.get(message.streamId);
    if (
      !stream ||
      stream.lease.proxyId !== proxyId ||
      stream.lease.leaseId !== message.leaseId ||
      stream.lease.previewId !== message.previewId
    ) {
      return;
    }
    clearTimeout(stream.startTimer);
    if (!message.success) {
      this.options.logger.warn(
        { streamId: stream.streamId, proxyId, error: message.error },
        "Device preview stream failed to start",
      );
      this.failStream(stream.streamId, streamErrorStatus(message.errorCode), message.error);
      return;
    }
    const format = message.format;
    if (stream.requestedFormat !== format) {
      this.failStream(stream.streamId, 502, "开发机返回了错误的设备画面格式", "stream_error");
      return;
    }
    stream.format = format;
    try {
      stream.res.status(200);
      stream.res.setHeader("Content-Type", STREAM_CONTENT_TYPE);
      stream.res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      stream.res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      stream.res.setHeader("X-Content-Type-Options", "nosniff");
      stream.res.setHeader("X-Accel-Buffering", "no");
      stream.res.setHeader("X-Device-Preview-Format", format);
      if (message.width !== undefined)
        stream.res.setHeader("X-Device-Width", String(message.width));
      if (message.height !== undefined)
        stream.res.setHeader("X-Device-Height", String(message.height));
      stream.res.flushHeaders();
      stream.headersSent = true;
      stream.state = "streaming";
      // Both backends are allowed to be change-driven: a static simulator can legitimately emit
      // nothing after its first renderable image. This deadline proves startup only. Ongoing
      // liveness comes from the Proxy stream WebSocket heartbeat and explicit capture completion,
      // not from visual changes on the device.
      this.armFirstFrameTimer(stream);
      const bufferedFrame = stream.bufferedStartingFrame;
      stream.bufferedStartingFrame = undefined;
      const bufferedH264 = stream.bufferedStartingH264;
      stream.bufferedStartingH264 = undefined;
      if (format === "h264_annex_b" && bufferedH264) {
        for (const packet of bufferedH264.packets) this.writeH264Packet(stream, packet);
      } else if (format === "jpeg" && bufferedFrame) {
        this.writeFrame(stream, bufferedFrame.sequence, bufferedFrame.jpeg);
      }
    } catch (error) {
      this.failStream(stream.streamId, 500, errorText(error), "stream_error");
    }
  }

  private handleStreamComplete(
    proxyId: string,
    message: ControlMessage<"device_preview_stream_complete">,
  ): void {
    const stream = this.streams.get(message.streamId);
    if (
      !stream ||
      stream.lease.proxyId !== proxyId ||
      stream.lease.leaseId !== message.leaseId ||
      stream.lease.previewId !== message.previewId
    ) {
      return;
    }
    this.options.logger.warn(
      { streamId: stream.streamId, proxyId, error: message.error },
      "Device preview stream capture failed",
    );
    this.failStream(stream.streamId, 502, message.error);
  }

  private handleInputAck(
    proxyId: string,
    message: ControlMessage<"device_preview_input_ack">,
    raw: string,
  ): void {
    const lease = this.leases.get(message.leaseId);
    if (
      !lease ||
      lease.proxyId !== proxyId ||
      !lease.outstandingInputSeqs.delete(message.inputSeq) ||
      lease.clientWs.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const response = rewriteForwardedControl(raw, {
      type: message.type,
      scope: { proxyId: lease.proxyId, bindingId: lease.bindingId },
    });
    this.sendClient(lease.clientWs, response, message.type, () => {
      return (
        this.leases.get(lease.leaseId) === lease &&
        lease.controller &&
        this.clientLeaseStillValid(lease)
      );
    });
  }

  private handleFrame(
    transport: StreamTransport,
    streamId: string,
    sequence: number,
    jpeg: Uint8Array,
  ): void {
    const stream = this.streams.get(streamId);
    if (
      !stream ||
      stream.finished ||
      stream.transport !== transport ||
      stream.lease.proxyId !== transport.proxyId
    ) {
      return;
    }
    if (stream.requestedFormat !== "jpeg") return;
    if (stream.state === "streaming" && stream.format !== undefined && stream.format !== "jpeg") {
      this.failStream(streamId, 502, "开发机发送了错误的设备画面格式", "stream_error");
      return;
    }
    if (stream.lastFrameSequence !== null && sequence <= stream.lastFrameSequence) return;
    stream.lastFrameSequence = sequence;
    if (stream.state === "starting") {
      // Proxy can synchronously publish a capture group's cached frame before its async start
      // response reaches Relay. Keep only the newest validated JPEG, scoped to this exact stream
      // transport, so a still device can render immediately once the HTTP response is established.
      stream.bufferedStartingFrame = { sequence, jpeg: Buffer.from(jpeg) };
      return;
    }
    this.writeFrame(stream, sequence, jpeg);
  }

  private handleH264Packet(
    transport: StreamTransport,
    streamId: string,
    packet: DevicePreviewH264Packet,
  ): void {
    const stream = this.streams.get(streamId);
    if (
      !stream ||
      stream.finished ||
      stream.transport !== transport ||
      stream.lease.proxyId !== transport.proxyId
    ) {
      return;
    }
    if (stream.requestedFormat !== "h264_annex_b") {
      return;
    }
    if (stream.state === "streaming" && stream.format !== "h264_annex_b") {
      this.failStream(streamId, 502, "开发机发送了错误的设备画面格式", "stream_error");
      return;
    }
    if (stream.lastFrameSequence !== null && packet.packetSequence <= stream.lastFrameSequence) {
      return;
    }
    stream.lastFrameSequence = packet.packetSequence;
    if (stream.state === "starting") {
      if (packet.configuration) {
        const configuration: BufferedStartingH264Packet = {
          ...packet,
          annexB: Buffer.from(packet.annexB),
        };
        stream.bufferedStartingH264 = {
          configuration,
          packets: [configuration],
          totalBytes: configuration.annexB.length,
          hasKeyframe: false,
        };
        return;
      }
      const buffered = stream.bufferedStartingH264;
      if (!buffered) return;
      if (packet.keyframe) {
        const keyframe: BufferedStartingH264Packet = {
          ...packet,
          annexB: Buffer.from(packet.annexB),
        };
        buffered.packets = [buffered.configuration, keyframe];
        buffered.totalBytes = buffered.configuration.annexB.length + keyframe.annexB.length;
        buffered.hasKeyframe = true;
        return;
      }
      if (!buffered.hasKeyframe) return;
      if (
        buffered.packets.length >= MAX_BUFFERED_STARTING_H264_PACKETS ||
        buffered.totalBytes + packet.annexB.length > MAX_BUFFERED_STARTING_H264_BYTES
      ) {
        buffered.packets = [buffered.configuration];
        buffered.totalBytes = buffered.configuration.annexB.length;
        buffered.hasKeyframe = false;
        this.requestH264Resync(stream);
        return;
      }
      const copy: BufferedStartingH264Packet = {
        ...packet,
        annexB: Buffer.from(packet.annexB),
      };
      buffered.packets.push(copy);
      buffered.totalBytes += copy.annexB.length;
      return;
    }
    this.writeH264Packet(stream, packet);
  }

  private writeFrame(stream: ActiveStream, sequence: number, jpeg: Uint8Array): void {
    if (stream.paused) return;

    const record = encodeDevicePreviewHttpFrame(sequence, jpeg);
    const writeResult = this.writeStreamRecord(stream, record);
    if (writeResult !== "failed") this.clearFirstFrameTimer(stream);
  }

  private writeH264Packet(stream: ActiveStream, packet: DevicePreviewH264Packet): void {
    if (stream.paused) {
      stream.h264DroppedWhilePaused = true;
      return;
    }
    if (stream.h264SyncState === "awaiting_configuration" && !packet.configuration) return;
    if (stream.h264SyncState === "awaiting_keyframe" && !packet.configuration && !packet.keyframe) {
      return;
    }
    const establishesSync =
      stream.h264SyncState === "awaiting_keyframe" && !packet.configuration && packet.keyframe;
    const record = encodeDevicePreviewH264HttpPacket(packet);
    const writeResult = this.writeStreamRecord(stream, record);
    if (writeResult === "failed" || stream.finished) return;

    if (packet.configuration) {
      stream.h264SyncState = "awaiting_keyframe";
    } else if (establishesSync) {
      stream.h264SyncState = "synced";
      this.clearFirstFrameTimer(stream);
    }
  }

  private writeStreamRecord(stream: ActiveStream, record: Uint8Array): StreamWriteResult {
    let writable: boolean;
    try {
      writable = stream.res.write(Buffer.from(record));
    } catch (error) {
      this.failStream(stream.streamId, 502, errorText(error), "stream_error");
      return "failed";
    }
    if (writable) return "writable";

    stream.paused = true;
    stream.h264DroppedWhilePaused = false;
    this.sendFlow(stream, true, false);
    const onDrain = (): void => {
      stream.drainListener = undefined;
      if (stream.drainTimer) clearTimeout(stream.drainTimer);
      stream.drainTimer = undefined;
      if (stream.finished || !stream.paused) return;
      stream.paused = false;
      const resyncRequired = stream.format === "h264_annex_b" && stream.h264DroppedWhilePaused;
      stream.h264DroppedWhilePaused = false;
      if (resyncRequired) {
        stream.h264SyncState = "awaiting_configuration";
      }
      this.sendFlow(stream, false, resyncRequired);
    };
    stream.drainListener = onDrain;
    stream.res.once("drain", onDrain);
    stream.drainTimer = setTimeout(() => {
      stream.drainTimer = undefined;
      if (stream.finished || !stream.paused) return;
      this.failStream(stream.streamId, 504, "设备画面发送超时", "stream_error");
    }, this.drainTimeoutMs);
    stream.drainTimer.unref?.();
    return "backpressured";
  }

  private requestH264Resync(stream: ActiveStream): void {
    if (stream.finished || stream.transport.ws.readyState !== WebSocket.OPEN) return;
    // Reuse per-stream flow control to discard the Proxy viewer's stale GOP and request a fresh
    // configuration + keyframe pair without disturbing other viewers sharing the capture source.
    this.sendFlow(stream, true, false);
    this.sendFlow(stream, false, true);
  }

  private armFirstFrameTimer(stream: ActiveStream): void {
    if (stream.firstFrameTimer || stream.finished) return;
    stream.firstFrameTimer = setTimeout(() => {
      this.failStream(stream.streamId, 504, "等待设备画面首帧超时", "stream_error");
    }, this.firstFrameTimeoutMs);
    stream.firstFrameTimer.unref?.();
  }

  private clearFirstFrameTimer(stream: ActiveStream): void {
    if (!stream.firstFrameTimer) return;
    clearTimeout(stream.firstFrameTimer);
    stream.firstFrameTimer = null;
  }

  private sendFlow(stream: ActiveStream, paused: boolean, resyncRequired: boolean): void {
    if (stream.transport.ws.readyState !== WebSocket.OPEN) return;
    stream.transport.ws.send(
      JSON.stringify({
        type: "device_preview_stream_flow",
        streamId: stream.streamId,
        paused,
        resyncRequired,
      }),
    );
  }

  private failStream(
    streamId: string,
    status: number,
    error: string,
    stopReason?: DevicePreviewStreamStopReason,
  ): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    if (!stream.headersSent) {
      this.markStreamFinished(stream, stopReason);
      stream.res.status(status).json({ error });
      this.releaseLease(stream.lease, "stream_closed", true);
      return;
    }
    this.markStreamFinished(stream, stopReason);
    stream.res.destroy(new Error(error));
    this.releaseLease(stream.lease, "stream_closed", true);
  }

  private finishStream(
    stream: ActiveStream,
    reason: DevicePreviewStreamStopReason,
    sendStop: boolean,
    error?: string,
    notifyLease = true,
  ): void {
    if (stream.finished) return;
    this.markStreamFinished(stream, sendStop ? reason : undefined);
    if (error) {
      if (!stream.headersSent) stream.res.status(502).json({ error });
      else stream.res.destroy(new Error(error));
    } else {
      stream.res.end();
    }
    this.releaseLease(
      stream.lease,
      reason === "proxy_offline" ? "proxy_offline" : "stream_closed",
      notifyLease,
    );
  }

  private markStreamFinished(
    stream: ActiveStream,
    stopReason?: DevicePreviewStreamStopReason,
  ): void {
    stream.finished = true;
    this.streams.delete(stream.streamId);
    stream.bufferedStartingFrame = undefined;
    stream.bufferedStartingH264 = undefined;
    clearTimeout(stream.startTimer);
    this.clearFirstFrameTimer(stream);
    if (stream.drainListener) stream.res.removeListener("drain", stream.drainListener);
    if (stream.drainTimer) clearTimeout(stream.drainTimer);
    stream.drainListener = undefined;
    stream.drainTimer = undefined;
    if (stopReason && stream.lease.proxyWs.readyState === WebSocket.OPEN) {
      this.sendProxyInternal(
        stream.lease.proxyWs,
        serializeControl({
          type: "device_preview_stream_stop",
          streamId: stream.streamId,
          reason: stopReason,
        }),
      );
    }
    if (stream.lease.streamId === stream.streamId) stream.lease.streamId = undefined;
  }

  private stopPreviewStreams(
    proxyId: string,
    previewId: string,
    reason: DevicePreviewStreamStopReason,
  ): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.lease.proxyId === proxyId && stream.lease.previewId === previewId) {
        this.finishStream(stream, reason, true, "设备预览已关闭");
      }
    }
    for (const lease of [...this.leases.values()]) {
      if (lease.proxyId === proxyId && lease.previewId === previewId && !lease.streamId) {
        this.releaseLease(lease, "stream_closed", true);
      }
    }
  }

  private failStreamsForTransport(transport: StreamTransport, error: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.transport.ws === transport.ws) {
        this.failStream(stream.streamId, 502, error, "stream_error");
      }
    }
  }

  private releaseLease(
    lease: ControlLease,
    reason: "stream_closed" | "proxy_offline" | "lease_expired",
    notify: boolean,
  ): void {
    if (this.leases.get(lease.leaseId) !== lease) return;
    this.leases.delete(lease.leaseId);
    if (lease.token) {
      const token = this.tokens.get(lease.token);
      if (token) {
        clearTimeout(token.timer);
        this.tokens.delete(token.token);
      }
      lease.token = undefined;
    }
    const key = previewKey(lease.proxyId, lease.previewId);
    if (this.controllerByPreview.get(key) === lease.leaseId) {
      this.controllerByPreview.delete(key);
      if (notify) this.sendControlRevoked(lease, reason);
    }
  }

  private expireToken(token: StreamToken): void {
    if (this.tokens.get(token.token) !== token) return;
    this.tokens.delete(token.token);
    clearTimeout(token.timer);
    const lease = this.leases.get(token.leaseId);
    if (lease && !lease.streamId) this.releaseLease(lease, "lease_expired", true);
  }

  private cleanupExpiredTokens(): void {
    const now = this.now();
    for (const token of [...this.tokens.values()]) {
      if (token.expiresAt <= now) this.expireToken(token);
    }
  }

  private hasLeaseCapacity(clientId: string, proxyId: string, previewId: string): boolean {
    if (this.leases.size >= this.maxStreams) return false;
    let forClient = 0;
    let forProxy = 0;
    let forPreview = 0;
    for (const lease of this.leases.values()) {
      if (lease.clientId === clientId) forClient += 1;
      if (lease.proxyId === proxyId) forProxy += 1;
      if (lease.proxyId === proxyId && lease.previewId === previewId) forPreview += 1;
    }
    return (
      forClient < this.maxStreamsPerClient &&
      forProxy < this.maxStreamsPerProxy &&
      forPreview < this.maxStreamsPerPreview
    );
  }

  private clientBindingStillMatches(lease: ControlLease): boolean {
    const binding = this.options.registry.getClientBinding(lease.clientId);
    return (
      lease.clientWs.readyState === WebSocket.OPEN &&
      lease.clientWs.boundProxyId === lease.proxyId &&
      lease.clientWs.bindingId === lease.bindingId &&
      binding?.proxyId === lease.proxyId &&
      binding.bindingId === lease.bindingId &&
      binding.ws === lease.clientWs
    );
  }

  private clientLeaseStillValid(lease: ControlLease): boolean {
    const connection = this.proxyConnections.get(lease.proxyId);
    return (
      this.clientBindingStillMatches(lease) &&
      this.options.registry.getProxy(lease.proxyId) === lease.proxyWs &&
      connection?.proxyWs === lease.proxyWs
    );
  }

  private sendControlRevoked(
    lease: ControlLease,
    reason: "taken_over" | "stream_closed" | "proxy_offline" | "lease_expired",
  ): void {
    const isStillRelevant = (): boolean =>
      this.clientBindingStillMatches(lease) &&
      (reason !== "taken_over" || (this.leases.get(lease.leaseId) === lease && !lease.controller));
    if (!isStillRelevant()) return;
    this.sendClient(
      lease.clientWs,
      serializeControl({
        type: "device_preview_control_revoked_push",
        scope: { proxyId: lease.proxyId, bindingId: lease.bindingId },
        leaseId: lease.leaseId,
        reason,
      }),
      "device_preview_control_revoked_push",
      isStillRelevant,
    );
  }

  private allocateUniqueToken(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = this.tokenFactory();
      if (!this.tokens.has(token)) return token;
    }
    throw new Error("Unable to allocate a unique Device Preview stream token");
  }

  private allocateUniqueRuntimeId(
    values: ReadonlyMap<string, unknown>,
    kind: "lease" | "stream",
  ): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.idFactory();
      if (!values.has(id)) return id;
    }
    throw new Error(`Unable to allocate a unique Device Preview ${kind} ID`);
  }

  private clearProxyRuntime(proxyId: string, reason: "proxy_offline", notify: boolean): void {
    this.routes.clearProxy(proxyId);
    const transport = this.transports.get(proxyId);
    if (transport) {
      this.transports.delete(proxyId);
      transport.ws.terminate();
    }
    for (const stream of [...this.streams.values()]) {
      if (stream.lease.proxyId !== proxyId) continue;
      this.finishStream(stream, "proxy_offline", false, "开发机已断开", notify);
    }
    for (const lease of [...this.leases.values()]) {
      if (lease.proxyId === proxyId && !lease.streamId) this.releaseLease(lease, reason, notify);
    }
  }

  private isCurrentProxyConnection(proxyId: string, proxyWs: WebSocket): boolean {
    return (
      this.proxyConnections.get(proxyId)?.proxyWs === proxyWs &&
      this.options.registry.getProxy(proxyId) === proxyWs
    );
  }

  private isDeviceMessage(message: RelayControlMessage): boolean {
    return message.type.startsWith("device_preview_");
  }

  private rejectTransport(ws: WebSocket, reason: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(RelayCloseCode.DEVICE_STREAM_PROTOCOL_REJECTED, reason.slice(0, 123));
    }
  }

  private sendClient(ws: WebSocket, raw: string, type: string, guard?: () => boolean): void {
    if (ws.readyState !== WebSocket.OPEN || (guard && !guard())) return;
    if (this.options.chaos) {
      this.options.chaos.send(ws, raw, {
        direction: "proxy_to_client",
        type,
        ...(guard ? { guard } : {}),
      });
    } else if (!guard || guard()) {
      ws.send(raw);
    }
  }

  private sendProxy(ws: WebSocket, raw: string, type: string, guard?: () => boolean): void {
    if (ws.readyState !== WebSocket.OPEN || (guard && !guard())) return;
    if (this.options.chaos) {
      this.options.chaos.send(ws, raw, {
        direction: "client_to_proxy",
        type,
        ...(guard ? { guard } : {}),
      });
    } else if (!guard || guard()) {
      ws.send(raw);
    }
  }

  /** Relay-owned lifecycle barriers bypass public chaos routing to preserve main-WS ordering. */
  private sendProxyInternal(ws: WebSocket, raw: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(raw);
      return true;
    } catch (error) {
      this.options.logger.warn(
        { error: errorText(error) },
        "Failed to send internal Device Preview control",
      );
      return false;
    }
  }

  private sendRelayError(
    ws: WebSocket,
    requestId: string,
    code: "NOT_REGISTERED" | "NOT_BOUND" | "PROXY_OFFLINE" | "INVALID_MESSAGE",
    message: string,
  ): void {
    this.sendClient(
      ws,
      JSON.stringify({ type: "relay_error", requestId, code, message }),
      "relay_error",
    );
  }
}
