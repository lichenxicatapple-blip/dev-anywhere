import { WebSocket } from "ws";
import {
  ControlErrorCode,
  isClientToProxyRelayControlType,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayCloseCode,
  RelayErrorCode,
  RelayProtocolRejectReason,
  type RelayProtocolRejectReasonType,
  RELAY_JSON_MESSAGE_MAX_BYTES,
  serializeControl,
  type ControlErrorCodeType,
  type PreviewScope,
  type RelayControlMessage,
} from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeClientMessage } from "../router.js";
import type { RelayChaos } from "../chaos.js";
import { handleVoiceConfigControl } from "../voice/client-controls.js";
import type { VoiceConfigStore } from "../voice/config-store.js";
import type { VoiceProviderRegistry } from "../voice/provider.js";
import { startRelayProxyLatencyProbe } from "../latency-probes.js";
import type { RemoteFileBridge } from "../remote-file-bridge.js";
import type { PtySnapshotRouteRegistry } from "../pty-snapshot-route-registry.js";
import type { SessionHistoryRouteRegistry } from "../session-history-route-registry.js";
import {
  isWebPreviewRequestMessage,
  webPreviewResponseByRequest,
  type WebPreviewRequestMessage,
  type WebPreviewRouteRegistry,
} from "../web-preview-route-registry.js";
import type { DevicePreviewBridge } from "../device-preview-bridge.js";
import { isDevicePreviewRequestMessage } from "../device-preview-route-registry.js";
import {
  classifyClientRegistrationProtocol,
  inspectClientRegistrationAdmission,
} from "../client-registration-admission.js";

// 扩展 WebSocket 实例存储客户端元数据
interface ClientSocket extends WebSocket {
  isAlive: boolean;
  admissionPhase: "awaiting" | "ready" | "rejected";
  clientId?: string;
  boundProxyId?: string;
  bindingId?: string;
}

interface ClientConnectionInfo {
  userAgent?: string;
  remoteAddress?: string;
}

interface ClientRegisterInfo {
  protocolVersion: number;
  clientId: string;
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  browserName: string;
  osName: string;
  deviceKind: "desktop" | "tablet" | "phone" | "unknown";
}

const DEFAULT_CLIENT_ADMISSION_TIMEOUT_MS = 10_000;
// 1013 (Try Again Later) deliberately remains outside the permanent protocol-rejection codes.
// A client which merely failed to finish registration in time should use its ordinary backoff.
const RETRYABLE_CLIENT_ADMISSION_TIMEOUT_CLOSE_CODE = 1013;

// 处理 client_register 消息：三种状态 restored / proxy_offline / new。
// relay 不缓存输出；恢复由 proxy 重新推送 session_list/agent_status/snapshot 等状态。
function handleClientRegister(
  registration: ClientRegisterInfo,
  clientWs: ClientSocket,
  registry: RelayRegistry,
  logger: Logger,
  webPreviewRoutes: WebPreviewRouteRegistry,
  devicePreviewBridge: DevicePreviewBridge,
): void {
  const { clientId } = registration;
  if (clientWs.clientId && clientWs.clientId !== clientId) {
    webPreviewRoutes.abandonSocket(clientWs);
    devicePreviewBridge.abandonClientSocket(clientWs);
    registry.unbindClientSocket(clientWs.clientId, clientWs);
  }
  clientWs.clientId = clientId;
  registry.updateConnectedClientMetadata(clientWs, {
    clientId,
    ...(registration.userAgent !== undefined ? { userAgent: registration.userAgent } : {}),
    ...(registration.platform !== undefined ? { platform: registration.platform } : {}),
    ...(registration.maxTouchPoints !== undefined
      ? { maxTouchPoints: registration.maxTouchPoints }
      : {}),
    browserName: registration.browserName,
    osName: registration.osName,
    deviceKind: registration.deviceKind,
  });

  const binding = registry.getClientBinding(clientId);

  if (!binding) {
    clientWs.send(
      serializeControl({
        type: "client_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "new",
      }),
    );
    logger.info({ clientId, status: "new" }, "Client registered");
    return;
  }

  const previousWs = binding.ws;
  if (previousWs) {
    // Registering an existing clientId always creates a new binding generation. Pending Preview
    // responses and private streams belong to the superseded generation, even when the same
    // physical WebSocket sends client_register again.
    webPreviewRoutes.abandonSocket(previousWs);
    devicePreviewBridge.abandonClientSocket(previousWs);
  }
  const restored = registry.restoreClientBinding(clientId, clientWs);
  if (!restored) {
    throw new Error(`Client binding disappeared while restoring ${clientId}`);
  }
  const { proxyId, bindingId } = restored;

  if (!registry.isProxyOnline(proxyId)) {
    clientWs.send(
      serializeControl({
        type: "client_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "proxy_offline",
        proxyId,
        bindingId,
      }),
    );
    logger.info({ clientId, proxyId, status: "proxy_offline" }, "Client registered");
    return;
  }

  // proxy 在线，恢复绑定（relay 无状态，不做增量回放）
  clientWs.send(
    serializeControl({
      type: "client_register_response",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      status: "restored",
      proxyId,
      bindingId,
    }),
  );

  logger.info({ clientId, proxyId, status: "restored" }, "Client registered");
}

function handleRelayClientListRequest(
  clientWs: ClientSocket,
  registry: RelayRegistry,
  requestId: string | undefined,
): void {
  clientWs.send(
    JSON.stringify({
      type: "relay_client_list_response",
      requestId,
      clients: registry.getConnectedClientDetails(clientWs.clientId),
    }),
  );
}

function proxyListResponse(registry: RelayRegistry): string {
  const proxies = registry.listProxiesWithName().map((proxy) => ({
    ...proxy,
    sessions: registry.getSessionsForProxy(proxy.proxyId),
  }));
  return serializeControl({ type: "proxy_list_response", proxies });
}

function broadcastProxyList(registry: RelayRegistry, chaos?: RelayChaos): void {
  const response = proxyListResponse(registry);
  for (const target of registry.getAllClientWs()) {
    if (chaos) {
      chaos.send(target, response, {
        direction: "proxy_to_client",
        type: "proxy_list_response",
      });
    } else {
      target.send(response);
    }
  }
}

function broadcastProxyRemoved(proxyId: string, registry: RelayRegistry, chaos?: RelayChaos): void {
  const notification = serializeControl({ type: "proxy_removed", proxyId });
  for (const target of registry.getAllClientWs()) {
    if (chaos) {
      chaos.send(target, notification, {
        direction: "proxy_to_client",
        type: "proxy_removed",
      });
    } else {
      target.send(notification);
    }
  }
}

function sendProxyRemoveResponse(
  clientWs: ClientSocket,
  response: {
    requestId: string;
    proxyId: string;
    success: boolean;
    errorCode?: ControlErrorCodeType;
    error?: string;
  },
  chaos?: RelayChaos,
): void {
  const raw = serializeControl({ type: "proxy_remove_response", ...response });
  if (chaos) {
    chaos.send(clientWs, raw, {
      direction: "proxy_to_client",
      type: "proxy_remove_response",
    });
  } else {
    clientWs.send(raw);
  }
}

function handleProxyRemove(
  clientWs: ClientSocket,
  registry: RelayRegistry,
  logger: Logger,
  ptySnapshotRoutes: PtySnapshotRouteRegistry,
  sessionHistoryRoutes: SessionHistoryRouteRegistry,
  webPreviewRoutes: WebPreviewRouteRegistry,
  remoteFileBridge: RemoteFileBridge | undefined,
  devicePreviewBridge: DevicePreviewBridge,
  requestId: string,
  proxyId: string,
  chaos?: RelayChaos,
): void {
  const result = registry.removeOfflineProxy(proxyId);
  if (result === "not_found") {
    sendProxyRemoveResponse(
      clientWs,
      {
        requestId,
        proxyId,
        success: false,
        errorCode: ControlErrorCode.PROXY_NOT_FOUND,
        error: `开发机 ${proxyId} 不存在`,
      },
      chaos,
    );
    return;
  }
  if (result === "online") {
    sendProxyRemoveResponse(
      clientWs,
      {
        requestId,
        proxyId,
        success: false,
        errorCode: ControlErrorCode.PROXY_ONLINE,
        error: `开发机 ${proxyId} 仍在线，无法删除`,
      },
      chaos,
    );
    return;
  }

  ptySnapshotRoutes.clearProxy(proxyId);
  sessionHistoryRoutes.clearProxy(proxyId);
  webPreviewRoutes.clearProxy(proxyId);
  try {
    remoteFileBridge?.revokeProxy(proxyId);
  } catch (err) {
    // Proxy record and its routing bindings are already gone. A cleanup-side failure must not
    // strand the request without an ACK; revokeProxy deletes persistent tokens before touching
    // active HTTP responses, so old URLs remain unusable even on this exceptional path.
    logger.error({ err, proxyId }, "Failed to finish remote file cleanup for removed proxy");
  }
  try {
    devicePreviewBridge.revokeProxy(proxyId);
  } catch (err) {
    logger.error({ err, proxyId }, "Failed to finish Device Preview cleanup for removed proxy");
  }

  // cleanupProxy 会清掉发起者原有的 proxy binding；因此 ACK 必须直接写回当前
  // client WebSocket，不能再通过 binding 反查目标，否则删除自己的离线绑定时会丢响应。
  sendProxyRemoveResponse(clientWs, { requestId, proxyId, success: true }, chaos);
  broadcastProxyRemoved(proxyId, registry, chaos);
  broadcastProxyList(registry, chaos);
  logger.info({ proxyId, clientId: clientWs.clientId }, "Offline proxy removed by client");
}

function handleRelayClientKick(
  clientWs: ClientSocket,
  registry: RelayRegistry,
  logger: Logger,
  requestId: string,
  targetClientId: string,
): void {
  if (targetClientId === clientWs.clientId) {
    clientWs.send(
      JSON.stringify({
        type: "relay_client_kick_response",
        requestId,
        clientId: targetClientId,
        success: false,
        errorCode: ControlErrorCode.UNKNOWN,
        error: "不能断开当前客户端",
      }),
    );
    return;
  }

  const targets = registry.getConnectedClientSockets(targetClientId);
  if (targets.length === 0) {
    clientWs.send(
      JSON.stringify({
        type: "relay_client_kick_response",
        requestId,
        clientId: targetClientId,
        success: false,
        errorCode: ControlErrorCode.UNKNOWN,
        error: "客户端不在线",
      }),
    );
    return;
  }

  const kickedMessage = JSON.stringify({
    type: "relay_client_kicked",
    reason: "由客户端管理断开",
  });
  for (const target of targets) {
    try {
      target.send(kickedMessage);
      target.close(RelayCloseCode.CLIENT_KICKED, "client kicked");
    } catch (err) {
      logger.warn({ err, clientId: targetClientId }, "Failed to close kicked client");
      target.terminate();
    } finally {
      registry.removeClientWs(target);
      registry.unbindClientById(targetClientId);
    }
  }

  clientWs.send(
    JSON.stringify({
      type: "relay_client_kick_response",
      requestId,
      clientId: targetClientId,
      success: true,
    }),
  );
  logger.info(
    { byClientId: clientWs.clientId, targetClientId, targetCount: targets.length },
    "Relay client kicked",
  );
}

function rejectNotBound(ws: ClientSocket, requestId?: string): void {
  ws.send(
    JSON.stringify({
      type: "relay_error",
      ...(requestId !== undefined ? { requestId } : {}),
      code: RelayErrorCode.NOT_BOUND,
      message: "Client is not bound to any proxy",
    }),
  );
}

function rejectNotRegistered(ws: ClientSocket, requestId: string | undefined): void {
  ws.send(
    JSON.stringify({
      type: "relay_error",
      requestId,
      code: RelayErrorCode.NOT_REGISTERED,
      message: "Client must register first",
    }),
  );
}

function rejectStaleBinding(ws: ClientSocket, requestId?: string): void {
  ws.send(
    JSON.stringify({
      type: "relay_error",
      ...(requestId ? { requestId } : {}),
      code: RelayErrorCode.STALE_BINDING,
      message: "Preview request used a stale client binding",
    }),
  );
}

function rejectStaleDevicePreviewInput(
  ws: ClientSocket,
  message: Extract<RelayControlMessage, { type: "device_preview_input" }>,
): void {
  ws.send(
    serializeControl({
      type: "device_preview_input_ack",
      scope: message.scope,
      leaseId: message.leaseId,
      inputSeq: message.inputSeq,
      success: false,
      error: "Preview request used a stale client binding",
      errorCode: ControlErrorCode.CONTROL_LEASE_INVALID,
    }),
  );
}

function sendWebPreviewFailure(
  ws: ClientSocket,
  message: WebPreviewRequestMessage,
  error: string,
  errorCode: ControlErrorCodeType,
): boolean {
  switch (message.type) {
    case "preview_capability_request":
      ws.send(
        serializeControl({
          type: "preview_capability_response",
          requestId: message.requestId,
          scope: message.scope,
          success: false,
          error,
          errorCode,
        }),
      );
      return true;
    case "preview_static_inspect_request":
      ws.send(
        serializeControl({
          type: "preview_static_inspect_response",
          requestId: message.requestId,
          scope: message.scope,
          success: false,
          error,
          errorCode,
        }),
      );
      return true;
    case "preview_create_request":
      ws.send(
        serializeControl({
          type: "preview_create_response",
          requestId: message.requestId,
          scope: message.scope,
          operationId: message.operationId,
          accepted: false,
          error,
          errorCode,
        }),
      );
      return true;
    case "preview_rename_request":
      ws.send(
        serializeControl({
          type: "preview_rename_response",
          requestId: message.requestId,
          scope: message.scope,
          operationId: message.operationId,
          previewId: message.previewId,
          success: false,
          error,
          errorCode,
        }),
      );
      return true;
    case "preview_reconnect_request":
      ws.send(
        serializeControl({
          type: "preview_reconnect_response",
          requestId: message.requestId,
          scope: message.scope,
          operationId: message.operationId,
          previewId: message.previewId,
          success: false,
          error,
          errorCode,
        }),
      );
      return true;
    case "preview_close_request":
      ws.send(
        serializeControl({
          type: "preview_close_response",
          requestId: message.requestId,
          scope: message.scope,
          operationId: message.operationId,
          previewId: message.previewId,
          success: false,
          error,
          errorCode,
        }),
      );
      return true;
    case "preview_list_request":
      return false;
  }
}

function validatePreviewScope(
  ws: ClientSocket,
  registry: RelayRegistry,
  requestId: string | undefined,
  scope: PreviewScope,
): boolean {
  if (registry.isCurrentClientBinding(ws.clientId, ws, scope)) return true;
  rejectStaleBinding(ws, requestId);
  return false;
}

function closeRejectedClientProtocol(
  ws: ClientSocket,
  reason: RelayProtocolRejectReasonType = RelayProtocolRejectReason.PROTOCOL_MISMATCH,
): void {
  if (!beginClientRejection(ws)) return;
  ws.close(RelayCloseCode.CLIENT_PROTOCOL_REJECTED, reason);
}

function beginClientRejection(ws: ClientSocket): boolean {
  if (ws.admissionPhase === "rejected") return false;
  ws.admissionPhase = "rejected";
  return ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED;
}

function closeUnversionedClientProtocol(ws: ClientSocket): void {
  // 4401 is the permanent-disconnect signal understood by clients from before the versioned
  // registration handshake. Sending it here is an admission-level tombstone only: the Relay does
  // not accept or translate the obsolete business protocol.
  if (!beginClientRejection(ws)) return;
  ws.send(
    JSON.stringify({
      type: "relay_client_kicked",
      reason: "页面版本已更新，请刷新",
    }),
  );
  ws.close(RelayCloseCode.CLIENT_KICKED, "client refresh required");
}

function rejectVersionedClientProtocol(
  ws: ClientSocket,
  clientProtocolVersion: unknown,
  reason: RelayProtocolRejectReasonType,
  clientId: string | undefined,
  logger: Logger,
): void {
  logger.warn(
    {
      ...(clientId !== undefined ? { clientId } : {}),
      clientProtocolVersion,
      relayProtocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      reason,
    },
    "Client control protocol rejected at admission",
  );
  closeRejectedClientProtocol(ws, reason);
}

function rejectProxySelect(ws: ClientSocket, requestId: string | undefined, proxyId: string): void {
  ws.send(
    serializeControl({
      type: "proxy_select_response",
      requestId,
      success: false,
      errorCode: ControlErrorCode.PROXY_OFFLINE,
      error: `Proxy not online: ${proxyId}`,
    }),
  );
}

function sendRelayProxyProbeFailure(
  ws: ClientSocket,
  requestId: string,
  error: string,
  chaos?: RelayChaos,
): void {
  const response = serializeControl({
    type: "latency_relay_proxy_response",
    requestId,
    success: false,
    error,
  });
  if (chaos) {
    chaos.send(ws, response, {
      direction: "proxy_to_client",
      type: "latency_relay_proxy_response",
    });
    return;
  }
  ws.send(response);
}

function sendRemoteFileUrlFailure(
  ws: ClientSocket,
  requestId: string,
  sessionId: string,
  error: string,
  errorCode: ControlErrorCodeType = ControlErrorCode.UNKNOWN,
): void {
  ws.send(
    serializeControl({
      type: "remote_file_url_response",
      requestId,
      sessionId,
      success: false,
      error,
      errorCode,
    }),
  );
}

function sendRemoteFileUploadUrlFailure(
  ws: ClientSocket,
  requestId: string,
  sessionId: string,
  error: string,
  errorCode: ControlErrorCodeType = ControlErrorCode.UNKNOWN,
): void {
  ws.send(
    serializeControl({
      type: "remote_file_upload_url_response",
      requestId,
      sessionId,
      success: false,
      error,
      errorCode,
    }),
  );
}

// 处理远程客户端 WebSocket 连接生命周期
export function handleClientConnection(
  ws: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
  ptySnapshotRoutes: PtySnapshotRouteRegistry,
  sessionHistoryRoutes: SessionHistoryRouteRegistry,
  webPreviewRoutes: WebPreviewRouteRegistry,
  devicePreviewBridge: DevicePreviewBridge,
  chaos?: RelayChaos,
  voiceConfigStore?: VoiceConfigStore,
  voiceProviders?: VoiceProviderRegistry,
  remoteFileBridge?: RemoteFileBridge,
  connectionInfo: ClientConnectionInfo = {},
  clientAdmissionTimeoutMs = DEFAULT_CLIENT_ADMISSION_TIMEOUT_MS,
): void {
  const clientWs = ws as ClientSocket;
  clientWs.isAlive = true;
  clientWs.admissionPhase = "awaiting";
  registry.addClientWs(clientWs, connectionInfo);

  const effectiveAdmissionTimeoutMs =
    Number.isSafeInteger(clientAdmissionTimeoutMs) && clientAdmissionTimeoutMs > 0
      ? clientAdmissionTimeoutMs
      : DEFAULT_CLIENT_ADMISSION_TIMEOUT_MS;
  let admissionTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    admissionTimeout = null;
    if (clientWs.admissionPhase !== "awaiting" || clientWs.readyState !== WebSocket.OPEN) return;
    if (!beginClientRejection(clientWs)) return;
    logger.warn(
      { timeoutMs: effectiveAdmissionTimeoutMs, remoteAddress: connectionInfo.remoteAddress },
      "Client registration timed out",
    );
    clientWs.close(RETRYABLE_CLIENT_ADMISSION_TIMEOUT_CLOSE_CODE, "client registration timeout");
  }, effectiveAdmissionTimeoutMs);
  admissionTimeout.unref?.();
  const clearAdmissionTimeout = (): void => {
    if (!admissionTimeout) return;
    clearTimeout(admissionTimeout);
    admissionTimeout = null;
  };

  clientWs.on("pong", () => {
    clientWs.isAlive = true;
  });

  clientWs.on("message", (data: Buffer, isBinary: boolean) => {
    if (clientWs.admissionPhase === "rejected") return;
    // Clients only send JSON control/envelope messages; binary frames from clients are ignored.
    if (isBinary) {
      if (!clientWs.clientId) closeRejectedClientProtocol(clientWs);
      return;
    }

    if (data.length > RELAY_JSON_MESSAGE_MAX_BYTES) {
      logger.warn(
        { size: data.length, clientId: clientWs.clientId },
        "JSON message rejected: exceeds max size",
      );
      if (!clientWs.clientId) closeRejectedClientProtocol(clientWs);
      return;
    }

    const raw = data.toString();
    const registrationAdmission = inspectClientRegistrationAdmission(raw);
    if (registrationAdmission.kind === "unversioned_client_registration") {
      logger.warn(
        {
          ...(registrationAdmission.clientId !== undefined
            ? { clientId: registrationAdmission.clientId }
            : {}),
        },
        "Unversioned client registration rejected",
      );
      closeUnversionedClientProtocol(clientWs);
      return;
    }
    if (registrationAdmission.kind === "versioned_client_registration") {
      const registrationProtocolIssue = classifyClientRegistrationProtocol(
        registrationAdmission.protocolVersion,
      );
      if (registrationProtocolIssue) {
        rejectVersionedClientProtocol(
          clientWs,
          registrationAdmission.protocolVersion,
          registrationProtocolIssue,
          registrationAdmission.clientId,
          logger,
        );
        return;
      }
    }

    const result = parseMessage(raw);

    if (result.kind === "control") {
      const msg = result.message;
      logger.info(
        { type: msg.type, clientId: clientWs.clientId, bound: clientWs.boundProxyId },
        "Client message received",
      );

      if (msg.type === "client_register") {
        handleClientRegister(
          msg,
          clientWs,
          registry,
          logger,
          webPreviewRoutes,
          devicePreviewBridge,
        );
        clientWs.admissionPhase = "ready";
        clearAdmissionTimeout();
        return;
      }

      if (!clientWs.clientId) {
        const requestId =
          "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : undefined;
        rejectNotRegistered(clientWs, requestId);
        closeRejectedClientProtocol(clientWs);
        return;
      }

      if (msg.type === "relay_client_list_request") {
        handleRelayClientListRequest(clientWs, registry, msg.requestId);
        return;
      }

      if (msg.type === "relay_client_kick") {
        handleRelayClientKick(clientWs, registry, logger, msg.requestId, msg.clientId);
        return;
      }

      if (msg.type === "proxy_remove") {
        if (!clientWs.clientId) {
          rejectNotRegistered(clientWs, msg.requestId);
          closeRejectedClientProtocol(clientWs);
          return;
        }
        handleProxyRemove(
          clientWs,
          registry,
          logger,
          ptySnapshotRoutes,
          sessionHistoryRoutes,
          webPreviewRoutes,
          remoteFileBridge,
          devicePreviewBridge,
          msg.requestId,
          msg.proxyId,
          chaos,
        );
        return;
      }

      const isScopedDevicePreviewMessage =
        isDevicePreviewRequestMessage(msg) ||
        msg.type === "device_preview_stream_url_request" ||
        msg.type === "device_preview_input" ||
        msg.type === "device_preview_control_claim_request";
      if (isScopedDevicePreviewMessage) {
        if (
          msg.type === "device_preview_input" &&
          !registry.isCurrentClientBinding(clientWs.clientId, clientWs, msg.scope)
        ) {
          rejectStaleDevicePreviewInput(clientWs, msg);
          return;
        }
        const requestId = msg.type === "device_preview_input" ? undefined : msg.requestId;
        if (!validatePreviewScope(clientWs, registry, requestId, msg.scope)) return;
        devicePreviewBridge.handleClientControl(clientWs, msg);
        return;
      }

      if (msg.type === "remote_file_url_request") {
        if (!remoteFileBridge) {
          sendRemoteFileUrlFailure(clientWs, msg.requestId, msg.sessionId, "文件流服务不可用");
          return;
        }
        if (!clientWs.clientId) {
          sendRemoteFileUrlFailure(
            clientWs,
            msg.requestId,
            msg.sessionId,
            "客户端未注册",
            ControlErrorCode.UNKNOWN,
          );
          return;
        }
        const targetProxyId = clientWs.boundProxyId;
        if (!targetProxyId || !registry.isProxyOnline(targetProxyId)) {
          sendRemoteFileUrlFailure(
            clientWs,
            msg.requestId,
            msg.sessionId,
            "当前未连接开发机",
            ControlErrorCode.PROXY_OFFLINE,
          );
          return;
        }
        const ownerProxyId = registry.getProxyForSession(msg.sessionId);
        if (ownerProxyId && ownerProxyId !== targetProxyId) {
          sendRemoteFileUrlFailure(
            clientWs,
            msg.requestId,
            msg.sessionId,
            "会话不属于当前开发机",
            ControlErrorCode.SESSION_NOT_FOUND,
          );
          return;
        }
        void remoteFileBridge
          .createUrl({
            clientId: clientWs.clientId,
            proxyId: targetProxyId,
            sessionId: msg.sessionId,
            path: msg.path,
            disposition: msg.disposition,
          })
          .then((result) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;
            if (!result.success) {
              sendRemoteFileUrlFailure(
                clientWs,
                msg.requestId,
                msg.sessionId,
                result.error,
                result.errorCode,
              );
              return;
            }
            clientWs.send(
              serializeControl({
                type: "remote_file_url_response",
                requestId: msg.requestId,
                sessionId: msg.sessionId,
                path: result.path,
                success: true,
                url: result.url,
                expiresAt: result.expiresAt,
              }),
            );
          })
          .catch((err: unknown) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;
            sendRemoteFileUrlFailure(
              clientWs,
              msg.requestId,
              msg.sessionId,
              err instanceof Error ? err.message : String(err),
            );
          });
        return;
      }

      if (msg.type === "remote_file_upload_url_request") {
        if (!remoteFileBridge) {
          sendRemoteFileUploadUrlFailure(clientWs, msg.requestId, msg.sessionId, "上传服务不可用");
          return;
        }
        if (!clientWs.clientId) {
          sendRemoteFileUploadUrlFailure(clientWs, msg.requestId, msg.sessionId, "客户端未注册");
          return;
        }
        const targetProxyId = clientWs.boundProxyId;
        if (!targetProxyId || !registry.isProxyOnline(targetProxyId)) {
          sendRemoteFileUploadUrlFailure(
            clientWs,
            msg.requestId,
            msg.sessionId,
            "当前未连接开发机",
            ControlErrorCode.PROXY_OFFLINE,
          );
          return;
        }
        const ownerProxyId = registry.getProxyForSession(msg.sessionId);
        if (ownerProxyId && ownerProxyId !== targetProxyId) {
          sendRemoteFileUploadUrlFailure(
            clientWs,
            msg.requestId,
            msg.sessionId,
            "会话不属于当前开发机",
            ControlErrorCode.SESSION_NOT_FOUND,
          );
          return;
        }
        const { uploadUrl, expiresAt } = remoteFileBridge.createUploadUrl({
          clientId: clientWs.clientId,
          proxyId: targetProxyId,
          sessionId: msg.sessionId,
          kind: msg.kind,
          fileName: msg.fileName,
          mimeType: msg.mimeType,
          size: msg.size,
        });
        clientWs.send(
          serializeControl({
            type: "remote_file_upload_url_response",
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            success: true,
            uploadUrl,
            expiresAt,
          }),
        );
        return;
      }

      if (msg.type === "proxy_list_request") {
        const proxies = registry.listProxiesWithName().map((proxy) => ({
          ...proxy,
          sessions: registry.getSessionsForProxy(proxy.proxyId),
        }));
        const response = serializeControl({
          type: "proxy_list_response",
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
          proxies,
        });
        if (chaos) {
          chaos.send(clientWs, response, {
            direction: "proxy_to_client",
            type: "proxy_list_response",
          });
        } else {
          clientWs.send(response);
        }
        return;
      }

      if (msg.type === "latency_web_relay_ping") {
        const response = serializeControl({
          type: "latency_web_relay_pong",
          requestId: msg.requestId,
          relayNow: Date.now(),
        });
        if (chaos) {
          chaos.send(clientWs, response, {
            direction: "proxy_to_client",
            type: "latency_web_relay_pong",
          });
        } else {
          clientWs.send(response);
        }
        return;
      }

      if (msg.type === "latency_relay_proxy_request") {
        const targetProxyId = clientWs.boundProxyId;
        if (!targetProxyId) {
          sendRelayProxyProbeFailure(clientWs, msg.requestId, "当前未连接开发机", chaos);
          return;
        }
        const proxyWs = registry.getProxy(targetProxyId);
        if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
          sendRelayProxyProbeFailure(
            clientWs,
            msg.requestId,
            `开发机 ${targetProxyId} 不在线`,
            chaos,
          );
          return;
        }
        startRelayProxyLatencyProbe({
          requestId: msg.requestId,
          proxyId: targetProxyId,
          proxyWs,
          clientWs,
          logger,
          chaos,
        });
        return;
      }

      if (
        voiceConfigStore &&
        handleVoiceConfigControl(msg, clientWs, voiceConfigStore, logger, voiceProviders)
      ) {
        return;
      }

      if (isWebPreviewRequestMessage(msg)) {
        if (!validatePreviewScope(clientWs, registry, msg.requestId, msg.scope)) {
          return;
        }
        const targetProxyId = clientWs.boundProxyId;
        if (!targetProxyId) {
          if (
            !sendWebPreviewFailure(
              clientWs,
              msg,
              "当前未连接开发机",
              ControlErrorCode.PROXY_OFFLINE,
            )
          ) {
            rejectNotBound(clientWs, msg.requestId);
          }
          return;
        }
        const proxyWs = registry.getProxy(targetProxyId);
        if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
          if (
            !sendWebPreviewFailure(
              clientWs,
              msg,
              `开发机 ${targetProxyId} 不在线`,
              ControlErrorCode.PROXY_OFFLINE,
            )
          ) {
            clientWs.send(
              JSON.stringify({
                type: "relay_error",
                requestId: msg.requestId,
                code: RelayErrorCode.PROXY_OFFLINE,
                message: `Proxy ${targetProxyId} is not available`,
              }),
            );
          }
          return;
        }

        let registration: ReturnType<WebPreviewRouteRegistry["register"]>;
        try {
          registration = webPreviewRoutes.register(
            targetProxyId,
            msg.requestId,
            webPreviewResponseByRequest[msg.type],
            clientWs,
            proxyWs,
          );
        } catch (error) {
          logger.error(
            { proxyId: targetProxyId, type: msg.type, error },
            "Could not allocate Web Preview management route",
          );
          if (
            !sendWebPreviewFailure(
              clientWs,
              msg,
              "暂时无法处理网页预览请求",
              ControlErrorCode.UNKNOWN,
            )
          ) {
            clientWs.send(
              JSON.stringify({
                type: "relay_error",
                requestId: msg.requestId,
                code: RelayErrorCode.INVALID_MESSAGE,
                message: "Could not allocate Web Preview request",
              }),
            );
          }
          return;
        }
        if (registration.kind !== "registered") {
          const message =
            registration.kind === "client_capacity_exceeded"
              ? "当前客户端有过多待处理的网页预览请求"
              : "网页预览请求过多";
          if (!sendWebPreviewFailure(clientWs, msg, message, ControlErrorCode.RATE_LIMITED)) {
            clientWs.send(
              JSON.stringify({
                type: "relay_error",
                requestId: msg.requestId,
                code: RelayErrorCode.INVALID_MESSAGE,
                message,
              }),
            );
          }
          return;
        }

        const upstreamRequest = {
          ...msg,
          requestId: registration.upstreamRequestId,
        } as WebPreviewRequestMessage;
        const upstreamRaw = serializeControl(upstreamRequest);
        const requestRouteStillCurrent = (): boolean =>
          clientWs.readyState === WebSocket.OPEN &&
          proxyWs.readyState === WebSocket.OPEN &&
          registry.getProxy(targetProxyId) === proxyWs &&
          registry.isCurrentClientBinding(clientWs.clientId, clientWs, msg.scope);
        if (!requestRouteStillCurrent()) return;
        if (chaos) {
          chaos.send(proxyWs, upstreamRaw, {
            direction: "client_to_proxy",
            type: msg.type,
            guard: requestRouteStillCurrent,
          });
        } else if (requestRouteStillCurrent()) {
          proxyWs.send(upstreamRaw);
        }
        return;
      }

      // client → proxy 透传：relay 不处理内容，直接转发给绑定的 proxy。
      // 路由 key 永远是 clientWs.boundProxyId, 不能被消息字段里 client 自填的 proxyId 覆盖
      // (那条路径让绑到 p1 的 client 通过 dir_list_request{proxyId:"p2"} 读到别的 proxy 的目录)。
      if (isClientToProxyRelayControlType(msg.type)) {
        const targetProxyId = clientWs.boundProxyId;
        if (!targetProxyId) {
          rejectNotBound(clientWs);
          return;
        }
        const proxyWs = registry.getProxy(targetProxyId);
        if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
          if (msg.type === "session_history_request") {
            const registration = sessionHistoryRoutes.register(
              targetProxyId,
              msg.requestId,
              clientWs,
              proxyWs,
            );
            if (registration.kind === "duplicate") {
              logger.debug(
                { proxyId: targetProxyId, requestId: msg.requestId },
                "Duplicate session history request suppressed",
              );
              return;
            }
            if (registration.kind === "joined") {
              logger.debug(
                {
                  proxyId: targetProxyId,
                  requestId: msg.requestId,
                  upstreamRequestId: registration.upstreamRequestId,
                },
                "Session history request joined active upstream flight",
              );
              return;
            }
            if (registration.kind !== "leader") {
              logger.warn(
                { proxyId: targetProxyId, requestId: msg.requestId, registration },
                "Session history response route rejected",
              );
              clientWs.send(
                JSON.stringify({
                  type: "relay_error",
                  requestId: msg.requestId,
                  code: RelayErrorCode.INVALID_MESSAGE,
                  message:
                    registration.kind === "collision"
                      ? "Session history requestId is already in use"
                      : "Too many pending session history requests",
                }),
              );
              return;
            }
            const upstreamRequest = serializeControl({
              type: "session_history_request",
              requestId: registration.upstreamRequestId,
            });
            if (chaos) {
              chaos.send(proxyWs, upstreamRequest, {
                direction: "client_to_proxy",
                type: msg.type,
              });
            } else {
              proxyWs.send(upstreamRequest);
            }
            return;
          }
          if (msg.type === "session_subscribe") {
            const registration = ptySnapshotRoutes.register(
              targetProxyId,
              msg.sessionId,
              msg.requestId,
              clientWs,
              proxyWs,
            );
            if (registration === "duplicate") {
              logger.debug(
                { proxyId: targetProxyId, sessionId: msg.sessionId, requestId: msg.requestId },
                "Duplicate PTY snapshot subscribe suppressed",
              );
              return;
            }
            if (registration !== "registered" && registration !== "retry_due") {
              logger.warn(
                {
                  proxyId: targetProxyId,
                  sessionId: msg.sessionId,
                  requestId: msg.requestId,
                  registration,
                },
                "PTY snapshot subscribe route rejected",
              );
              clientWs.send(
                JSON.stringify({
                  type: "relay_error",
                  requestId: msg.requestId,
                  code: RelayErrorCode.INVALID_MESSAGE,
                  message:
                    registration === "collision"
                      ? "PTY snapshot requestId is already in use"
                      : "Too many pending PTY snapshot requests",
                }),
              );
              return;
            }
            if (registration === "retry_due") {
              logger.debug(
                { proxyId: targetProxyId, sessionId: msg.sessionId, requestId: msg.requestId },
                "Retrying unanswered PTY snapshot subscribe",
              );
            }
          }
          if (chaos) chaos.send(proxyWs, raw, { direction: "client_to_proxy", type: msg.type });
          else proxyWs.send(raw);
        } else {
          clientWs.send(
            JSON.stringify({
              type: "relay_error",
              code: RelayErrorCode.PROXY_OFFLINE,
              message: `Proxy ${targetProxyId} is not available`,
            }),
          );
        }
        return;
      }

      if (msg.type === "proxy_select") {
        if (!clientWs.clientId) {
          rejectNotRegistered(clientWs, msg.requestId);
          closeRejectedClientProtocol(clientWs);
          return;
        }
        if (!registry.isProxyOnline(msg.proxyId)) {
          rejectProxySelect(clientWs, msg.requestId, msg.proxyId);
          return;
        }
        const bindingId = registry.bindClientById(clientWs.clientId, msg.proxyId, clientWs);
        if (!bindingId) {
          rejectProxySelect(clientWs, msg.requestId, msg.proxyId);
          return;
        }
        // Every successful selection installs a new binding generation, including re-selecting
        // the same Proxy. Any in-flight Preview work belongs to the previous generation.
        webPreviewRoutes.abandonSocket(clientWs);
        devicePreviewBridge.abandonClientSocket(clientWs);
        const response = serializeControl({
          type: "proxy_select_response",
          requestId: msg.requestId,
          success: true,
          proxyId: msg.proxyId,
          bindingId,
        });
        const selectedScope = { proxyId: msg.proxyId, bindingId };
        const selectionStillCurrent = (): boolean =>
          registry.isCurrentClientBinding(clientWs.clientId, clientWs, selectedScope);
        if (chaos) {
          chaos.send(clientWs, response, {
            direction: "proxy_to_client",
            type: "proxy_select_response",
            guard: selectionStillCurrent,
          });
        } else if (selectionStillCurrent()) {
          clientWs.send(response);
        }
        logger.info({ proxyId: msg.proxyId, clientId: clientWs.clientId }, "Client bound to proxy");
        return;
      }

      clientWs.send(
        JSON.stringify({
          type: "relay_error",
          code: RelayErrorCode.UNSUPPORTED,
          message: `Unsupported control message: ${msg.type}`,
        }),
      );
      return;
    }

    if (result.kind === "envelope") {
      if (!clientWs.clientId) {
        rejectNotRegistered(clientWs, undefined);
        closeRejectedClientProtocol(clientWs);
        return;
      }
      if (!clientWs.boundProxyId) {
        rejectNotBound(clientWs);
        return;
      }
      routeClientMessage(raw, clientWs.boundProxyId, clientWs, registry, logger, chaos);
      return;
    }

    const isRegistrationAttempt = registrationAdmission.kind !== "not_client_registration";
    const logContext = {
      error: result.error,
      raw: raw.slice(0, 200),
      ...(registrationAdmission.kind !== "not_client_registration" &&
      registrationAdmission.clientId !== undefined
        ? { clientId: registrationAdmission.clientId }
        : {}),
    };
    logger.error(logContext, "Invalid message from client");
    clientWs.send(
      JSON.stringify({
        type: "relay_error",
        code: RelayErrorCode.INVALID_MESSAGE,
        message: `${result.error} | raw: ${raw.slice(0, 200)}`,
      }),
    );
    if (isRegistrationAttempt || !clientWs.clientId) {
      closeRejectedClientProtocol(clientWs);
    }
  });

  clientWs.on("close", (code: number, reason: Buffer) => {
    clearAdmissionTimeout();
    clientWs.admissionPhase = "rejected";
    ptySnapshotRoutes.abandonSocket(clientWs);
    sessionHistoryRoutes.abandonSocket(clientWs);
    webPreviewRoutes.abandonSocket(clientWs);
    devicePreviewBridge.abandonClientSocket(clientWs);
    registry.removeClientWs(clientWs);
    // 清掉 binding.ws 引用：保留绑定关系（重连时还能恢复 proxyId 关联），但释放对已关闭 ws 对象的强引用，
    // 避免高频重连下 clientBindings Map 长期持有死 ws 对象阻止 GC，同时让 countClients 数字不再虚高。
    if (clientWs.clientId) {
      registry.unbindClientSocket(clientWs.clientId, clientWs);
    }
    logger.info(
      {
        clientId: clientWs.clientId,
        boundProxyId: clientWs.boundProxyId,
        code,
        reason: reason.toString() || undefined,
      },
      "Client disconnected",
    );
  });

  clientWs.on("error", (err) => {
    logger.error({ err }, "Client WebSocket error");
  });
}
