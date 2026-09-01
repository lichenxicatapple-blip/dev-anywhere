import type { Request, Response } from "express";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import {
  ControlErrorCode,
  DEVICE_PREVIEW_FRAME_MAX_BYTES,
  DevicePreviewStreamRegisterSchema,
  RelayCloseCode,
  decodeDevicePreviewFrame,
  encodeDevicePreviewHttpFrame,
  serializeControl,
  type ControlMessage,
  type ControlErrorCodeType,
  type DevicePreviewStreamProfile,
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

const DEFAULT_TOKEN_TTL_MS = 20_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_FRAME_IDLE_TIMEOUT_MS = 20_000;
const DEFAULT_REGISTER_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STREAMS = 64;
const DEFAULT_MAX_STREAMS_PER_PROXY = 8;
const DEFAULT_MAX_STREAMS_PER_CLIENT = 2;
const DEFAULT_MAX_STREAMS_PER_PREVIEW = 3;
const DEFAULT_MAX_INPUTS_PER_SECOND = 120;
const DEFAULT_MAX_OUTSTANDING_INPUTS_PER_LEASE = 32;
const STREAM_CONTENT_TYPE = "application/x-dev-anywhere-device-preview";

type ClientSocket = WebSocket & { clientId?: string; boundProxyId?: string };
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
  profile?: DevicePreviewStreamProfile;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface BufferedStartingFrame {
  sequence: number;
  jpeg: Uint8Array;
}

interface ActiveStream {
  streamId: string;
  lease: ControlLease;
  transport: StreamTransport;
  res: Response;
  state: "starting" | "streaming";
  startTimer: ReturnType<typeof setTimeout>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  headersSent: boolean;
  finished: boolean;
  paused: boolean;
  lastFrameSequence: number | null;
  bufferedStartingFrame?: BufferedStartingFrame;
  drainListener?: () => void;
}

export interface DevicePreviewBridgeOptions {
  registry: RelayRegistry;
  logger: Logger;
  chaos?: RelayChaos;
  clientTokenRequired?: boolean;
  validateClientToken?: (token: string | null) => boolean;
  tokenTtlMs?: number;
  startTimeoutMs?: number;
  frameIdleTimeoutMs?: number;
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
  private readonly frameIdleTimeoutMs: number;
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
    this.frameIdleTimeoutMs = Math.max(
      1,
      options.frameIdleTimeoutMs ?? DEFAULT_FRAME_IDLE_TIMEOUT_MS,
    );
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
      if (data.length > DEVICE_PREVIEW_FRAME_MAX_BYTES + 260) {
        this.options.logger.warn(
          { proxyId: registered.proxyId, bytes: data.length },
          "Oversized device preview frame dropped",
        );
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

  handleProxyControl(proxyId: string, proxyWs: WebSocket, message: RelayControlMessage): boolean {
    if (!this.isCurrentProxyConnection(proxyId, proxyWs)) return this.isDeviceMessage(message);
    if (isDevicePreviewResponseMessage(message)) {
      this.resolveManagementResponse(proxyId, proxyWs, message);
      return true;
    }
    switch (message.type) {
      case "device_preview_state_push":
        this.broadcastToProxyClients(proxyId, serializeControl(message), message.type);
        return true;
      case "device_preview_removed_push":
        this.stopPreviewStreams(proxyId, message.previewId, "preview_closed");
        this.broadcastToProxyClients(proxyId, serializeControl(message), message.type);
        return true;
      case "device_preview_stream_start_response":
        this.handleStreamStartResponse(proxyId, message);
        return true;
      case "device_preview_stream_complete":
        this.handleStreamComplete(proxyId, message);
        return true;
      case "device_preview_input_ack":
        this.handleInputAck(proxyId, message);
        return true;
      default:
        // Every device_preview_* message has an explicit Relay-owned route. Never let an
        // unexpected or locally-generated variant fall through to generic Proxy broadcasting.
        return this.isDeviceMessage(message);
    }
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
      idleTimer: null,
      headersSent: false,
      finished: false,
      paused: false,
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
      ...(profile?.maxFps !== undefined ? { maxFps: profile.maxFps } : {}),
      ...(profile?.maxWidth !== undefined ? { maxWidth: profile.maxWidth } : {}),
      ...(profile?.jpegQuality !== undefined ? { jpegQuality: profile.jpegQuality } : {}),
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
      this.sendRelayError(clientWs, message.requestId, "NOT_REGISTERED", "客户端未注册");
      return;
    }
    const proxyId = clientWs.boundProxyId;
    if (!proxyId) {
      this.sendRelayError(clientWs, message.requestId, "NOT_BOUND", "当前未连接开发机");
      return;
    }
    const proxyWs = this.options.registry.getProxy(proxyId);
    if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
      this.sendRelayError(clientWs, message.requestId, "PROXY_OFFLINE", "当前开发机不在线");
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
      this.sendRelayError(
        clientWs,
        message.requestId,
        "INVALID_MESSAGE",
        "暂时无法处理设备预览请求",
      );
      return;
    }
    if (registration.kind !== "registered") {
      this.sendRelayError(
        clientWs,
        message.requestId,
        "INVALID_MESSAGE",
        registration.kind === "client_capacity_exceeded"
          ? "当前客户端有过多待处理的设备预览请求"
          : "设备预览请求过多",
      );
      return;
    }
    const upstream = {
      ...message,
      requestId: registration.upstreamRequestId,
    } as DevicePreviewRequestMessage;
    this.sendProxy(proxyWs, serializeControl(upstream), message.type);
  }

  private resolveManagementResponse(
    proxyId: string,
    proxyWs: WebSocket,
    message: DevicePreviewResponseMessage,
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
    if (route.clientWs.readyState !== WebSocket.OPEN) return;
    const response = {
      ...message,
      requestId: route.clientRequestId,
    } as DevicePreviewResponseMessage;
    this.sendClient(route.clientWs, serializeControl(response), message.type);
  }

  private issueStreamUrl(
    clientWs: ClientSocket,
    message: ControlMessage<"device_preview_stream_url_request">,
  ): void {
    const failure = (
      error: string,
      errorCode: ControlErrorCodeType = ControlErrorCode.UNKNOWN,
    ): void => {
      this.sendClient(
        clientWs,
        serializeControl({
          type: "device_preview_stream_url_response",
          requestId: message.requestId,
          previewId: message.previewId,
          success: false,
          error,
          errorCode,
        }),
        "device_preview_stream_url_response",
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
      ...(message.profile ? { profile: message.profile } : {}),
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
        previewId: message.previewId,
        success: true,
        url: `/api/device-preview-streams/${tokenValue}`,
        leaseId,
        expiresAt,
        controlMode: controller ? "controller" : "view_only",
      }),
      "device_preview_stream_url_response",
    );
  }

  private forwardInput(
    clientWs: ClientSocket,
    message: ControlMessage<"device_preview_input">,
  ): void {
    const lease = this.leases.get(message.leaseId);
    const reject = (
      error: string,
      errorCode: ControlErrorCodeType = ControlErrorCode.CONTROL_LEASE_INVALID,
    ): void => {
      this.sendClient(
        clientWs,
        serializeControl({
          type: "device_preview_input_ack",
          leaseId: message.leaseId,
          inputSeq: message.inputSeq,
          success: false,
          error,
          errorCode,
        }),
        "device_preview_input_ack",
      );
    };
    if (
      !lease ||
      lease.clientWs !== clientWs ||
      !lease.controller ||
      !lease.streamId ||
      !this.streams.has(lease.streamId) ||
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
    this.sendProxy(lease.proxyWs, serializeControl(message), message.type);
  }

  private claimControl(
    clientWs: ClientSocket,
    message: ControlMessage<"device_preview_control_claim_request">,
  ): void {
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
          leaseId: message.leaseId,
          success: false,
          controlMode: "view_only",
          error: "设备画面已失效",
          errorCode: ControlErrorCode.CONTROL_LEASE_INVALID,
        }),
        "device_preview_control_claim_response",
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
              leaseId: message.leaseId,
              success: false,
              controlMode: "view_only",
              error: "开发机连接已断开",
              errorCode: ControlErrorCode.PROXY_OFFLINE,
            }),
            "device_preview_control_claim_response",
          );
          return;
        }
        old.controller = false;
        old.lastInputSeq = -1;
        old.rateWindowStartedAt = this.now();
        old.inputCount = 0;
        for (const inputSeq of old.outstandingInputSeqs) {
          this.sendClient(
            old.clientWs,
            serializeControl({
              type: "device_preview_input_ack",
              leaseId: old.leaseId,
              inputSeq,
              success: false,
              error: "设备控制权已被其他客户端接管",
              errorCode: ControlErrorCode.CONTROL_LEASE_INVALID,
            }),
            "device_preview_input_ack",
          );
        }
        old.outstandingInputSeqs.clear();
        if (old.clientWs.readyState === WebSocket.OPEN) {
          this.sendClient(
            old.clientWs,
            serializeControl({
              type: "device_preview_control_revoked_push",
              leaseId: old.leaseId,
              reason: "taken_over",
            }),
            "device_preview_control_revoked_push",
          );
        }
      }
    }
    lease.controller = true;
    this.controllerByPreview.set(key, lease.leaseId);
    this.sendClient(
      clientWs,
      serializeControl({
        type: "device_preview_control_claim_response",
        requestId: message.requestId,
        leaseId: lease.leaseId,
        success: true,
        controlMode: "controller",
      }),
      "device_preview_control_claim_response",
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
      this.failStream(
        stream.streamId,
        streamErrorStatus(message.errorCode),
        message.error ?? "无法启动设备画面",
      );
      return;
    }
    try {
      stream.res.status(200);
      stream.res.setHeader("Content-Type", STREAM_CONTENT_TYPE);
      stream.res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      stream.res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      stream.res.setHeader("X-Content-Type-Options", "nosniff");
      stream.res.setHeader("X-Accel-Buffering", "no");
      if (message.width !== undefined)
        stream.res.setHeader("X-Device-Width", String(message.width));
      if (message.height !== undefined)
        stream.res.setHeader("X-Device-Height", String(message.height));
      stream.res.flushHeaders();
      stream.headersSent = true;
      stream.state = "streaming";
      const bufferedFrame = stream.bufferedStartingFrame;
      stream.bufferedStartingFrame = undefined;
      if (bufferedFrame) {
        this.writeFrame(stream, bufferedFrame.sequence, bufferedFrame.jpeg);
      } else {
        this.armIdleTimer(stream);
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
    if (!message.success) {
      this.failStream(stream.streamId, 502, message.error ?? "设备画面已中断");
      return;
    }
    this.finishStream(stream, "client_closed", false);
  }

  private handleInputAck(
    proxyId: string,
    message: ControlMessage<"device_preview_input_ack">,
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
    this.sendClient(lease.clientWs, serializeControl(message), message.type);
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

  private writeFrame(stream: ActiveStream, sequence: number, jpeg: Uint8Array): void {
    this.armIdleTimer(stream);
    if (stream.paused) return;

    const record = encodeDevicePreviewHttpFrame(sequence, jpeg);
    let writable: boolean;
    try {
      writable = stream.res.write(Buffer.from(record));
    } catch (error) {
      this.failStream(stream.streamId, 502, errorText(error), "stream_error");
      return;
    }
    if (writable) return;

    stream.paused = true;
    this.sendFlow(stream, true);
    const onDrain = (): void => {
      stream.drainListener = undefined;
      if (stream.finished || !stream.paused) return;
      stream.paused = false;
      this.sendFlow(stream, false);
    };
    stream.drainListener = onDrain;
    stream.res.once("drain", onDrain);
  }

  private armIdleTimer(stream: ActiveStream): void {
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => {
      this.failStream(stream.streamId, 504, "设备画面长时间没有新帧", "stream_error");
    }, this.frameIdleTimeoutMs);
    stream.idleTimer.unref?.();
  }

  private sendFlow(stream: ActiveStream, paused: boolean): void {
    if (stream.transport.ws.readyState !== WebSocket.OPEN) return;
    stream.transport.ws.send(
      JSON.stringify({ type: "device_preview_stream_flow", streamId: stream.streamId, paused }),
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
    clearTimeout(stream.startTimer);
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    if (stream.drainListener) stream.res.removeListener("drain", stream.drainListener);
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
      if (notify && lease.clientWs.readyState === WebSocket.OPEN) {
        this.sendClient(
          lease.clientWs,
          serializeControl({
            type: "device_preview_control_revoked_push",
            leaseId: lease.leaseId,
            reason,
          }),
          "device_preview_control_revoked_push",
        );
      }
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

  private clientLeaseStillValid(lease: ControlLease): boolean {
    const binding = this.options.registry.getClientBinding(lease.clientId);
    const connection = this.proxyConnections.get(lease.proxyId);
    return (
      lease.clientWs.readyState === WebSocket.OPEN &&
      lease.clientWs.boundProxyId === lease.proxyId &&
      binding?.proxyId === lease.proxyId &&
      binding.ws === lease.clientWs &&
      this.options.registry.getProxy(lease.proxyId) === lease.proxyWs &&
      connection?.proxyWs === lease.proxyWs
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

  private sendClient(ws: WebSocket, raw: string, type: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (this.options.chaos) {
      this.options.chaos.send(ws, raw, { direction: "proxy_to_client", type });
    } else {
      ws.send(raw);
    }
  }

  private sendProxy(ws: WebSocket, raw: string, type: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (this.options.chaos) {
      this.options.chaos.send(ws, raw, { direction: "client_to_proxy", type });
    } else {
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

  private broadcastToProxyClients(proxyId: string, raw: string, type: string): void {
    for (const clientWs of this.options.registry.getClientsForProxy(proxyId)) {
      this.sendClient(clientWs, raw, type);
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
