import { WebSocket } from "ws";
import {
  compareProxyRelayProtocolVersions,
  isProxyToClientRelayControlType,
  ProxyProtocolAdmissionDirection,
  RELAY_BINARY_FRAME_MAX_BYTES,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayErrorCode,
  RelayCloseCode,
  RELAY_JSON_MESSAGE_MAX_BYTES,
  serializeControl,
  type PreviewScope,
  type ProxyProtocolRejectDirection,
  type RelayControlMessage,
} from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { RelayRegistry } from "../registry.js";
import { parseMessage, routeProxyMessage } from "../router.js";
import type { RelayChaos } from "../chaos.js";
import { completeRelayProxyLatencyProbe } from "../latency-probes.js";
import type { RemoteFileBridge } from "../remote-file-bridge.js";
import type { PtySnapshotRouteRegistry } from "../pty-snapshot-route-registry.js";
import type { SessionHistoryRouteRegistry } from "../session-history-route-registry.js";
import {
  isWebPreviewResponseMessage,
  type WebPreviewResponseMessage,
  type WebPreviewRouteRegistry,
} from "../web-preview-route-registry.js";
import { RELAY_VERSION } from "../version.js";
import type { DevicePreviewBridge } from "../device-preview-bridge.js";
import {
  parseProxyUpgradeBootstrapRequest,
  sendProxyUpgradeBootstrapResponse,
} from "../proxy-upgrade-bootstrap.js";

// 扩展 WebSocket 实例存储代理元数据
interface ProxySocket extends WebSocket {
  isAlive: boolean;
  proxyId?: string;
  admissionPhase: "awaiting" | "ready" | "quarantined" | "rejected";
}

type BoundClientSocket = WebSocket & {
  clientId?: string;
  boundProxyId?: string;
  bindingId?: string;
};

const PREVIEW_EVENT_TYPES = new Set([
  "preview_state_event",
  "preview_removed_event",
  "device_preview_state_event",
  "device_preview_removed_event",
]);
const PREVIEW_PUSH_TYPES = new Set([
  "preview_state_push",
  "preview_removed_push",
  "device_preview_state_push",
  "device_preview_removed_push",
]);
const DEFAULT_PROXY_ADMISSION_TIMEOUT_MS = 10_000;
// A peer which did not finish registration may retry through its ordinary backoff. This is not
// the permanent protocol-rejection signal.
const RETRYABLE_PROXY_ADMISSION_TIMEOUT_CLOSE_CODE = 1013;

type PreviewEventMessage = Extract<
  RelayControlMessage,
  {
    type:
      | "preview_state_event"
      | "preview_removed_event"
      | "device_preview_state_event"
      | "device_preview_removed_event";
  }
>;

function isPreviewEventMessage(message: RelayControlMessage): message is PreviewEventMessage {
  return PREVIEW_EVENT_TYPES.has(message.type);
}

function isPreviewPushType(type: string): boolean {
  return PREVIEW_PUSH_TYPES.has(type);
}

function previewPushFromEvent(
  event: PreviewEventMessage,
  scope: PreviewScope,
): RelayControlMessage {
  switch (event.type) {
    case "preview_state_event":
      return { ...event, type: "preview_state_push", scope };
    case "preview_removed_event":
      return { ...event, type: "preview_removed_push", scope };
    case "device_preview_state_event":
      return { ...event, type: "device_preview_state_push", scope };
    case "device_preview_removed_event":
      return { ...event, type: "device_preview_removed_push", scope };
  }
}

function broadcastPreviewEvent(
  proxyId: string,
  sourceProxyWs: WebSocket,
  event: PreviewEventMessage,
  registry: RelayRegistry,
  chaos?: RelayChaos,
): number {
  let delivered = 0;
  for (const rawClientWs of registry.getClientsForProxy(proxyId)) {
    const clientWs = rawClientWs as BoundClientSocket;
    if (!clientWs.clientId || !clientWs.bindingId) continue;
    const scope = { proxyId, bindingId: clientWs.bindingId };
    const isCurrentRoute = (): boolean =>
      registry.getProxy(proxyId) === sourceProxyWs &&
      registry.isCurrentClientBinding(clientWs.clientId, clientWs, scope);
    if (!isCurrentRoute()) continue;

    const pushMessage = previewPushFromEvent(event, scope);
    const push = serializeControl(pushMessage);
    if (chaos) {
      chaos.send(clientWs, push, {
        direction: "proxy_to_client",
        type: pushMessage.type,
        guard: isCurrentRoute,
      });
    } else if (isCurrentRoute() && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(push);
    }
    delivered += 1;
  }
  return delivered;
}

// 通知绑定到指定 proxy 的所有客户端 proxy 已离线
function notifyClientsProxyOffline(
  proxyId: string,
  registry: RelayRegistry,
  logger: Logger,
  chaos?: RelayChaos,
): void {
  const clients = registry.getClientsForProxy(proxyId);
  const msg = JSON.stringify({ type: "proxy_offline", proxyId });
  for (const clientWs of clients) {
    if (chaos) chaos.send(clientWs, msg, { direction: "proxy_to_client", type: "proxy_offline" });
    else clientWs.send(msg);
  }
  logger.info({ proxyId, clientCount: clients.length }, "Notified clients of proxy offline");
}

// 通知绑定到指定 proxy 的所有客户端 proxy 已上线
function notifyClientsProxyOnline(
  proxyId: string,
  registry: RelayRegistry,
  logger: Logger,
  chaos?: RelayChaos,
): void {
  const clients = registry.getClientsForProxy(proxyId);
  const msg = JSON.stringify({ type: "proxy_online", proxyId });
  for (const clientWs of clients) {
    if (chaos) chaos.send(clientWs, msg, { direction: "proxy_to_client", type: "proxy_online" });
    else clientWs.send(msg);
  }
  logger.info({ proxyId, clientCount: clients.length }, "Notified clients of proxy online");
}

// proxy 上线或下线时，将最新的 proxy 列表推送给所有已连接的 client。
// 复用 proxy_list_response 消息类型，client 端已有对应处理逻辑，无需额外适配。
function broadcastProxyList(registry: RelayRegistry, chaos?: RelayChaos): void {
  const proxies = registry.listProxiesWithName().map((p) => ({
    ...p,
    sessions: registry.getSessionsForProxy(p.proxyId),
  }));
  const msg = JSON.stringify({ type: "proxy_list_response", proxies });
  for (const clientWs of registry.getAllClientWs()) {
    if (chaos)
      chaos.send(clientWs, msg, { direction: "proxy_to_client", type: "proxy_list_response" });
    else clientWs.send(msg);
  }
}

function rejectNotRegistered(ws: ProxySocket): void {
  ws.send(
    JSON.stringify({
      type: "relay_error",
      code: RelayErrorCode.NOT_REGISTERED,
      message: "Proxy must register before sending messages",
    }),
  );
}

function closeRejectedProxyProtocol(
  ws: ProxySocket,
  direction: ProxyProtocolRejectDirection = ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH,
): void {
  if (ws.admissionPhase === "rejected") return;
  ws.admissionPhase = "rejected";
  ws.close(RelayCloseCode.PROXY_PROTOCOL_REJECTED, direction);
}

function classifyInitialProxyProtocol(raw: string): ProxyProtocolRejectDirection | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH;
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as { type?: unknown }).type !== "proxy_register"
  ) {
    return ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH;
  }
  const direction = compareProxyRelayProtocolVersions(
    (value as { protocolVersion?: unknown }).protocolVersion,
    RELAY_CONTROL_PROTOCOL_VERSION,
  );
  return direction === ProxyProtocolAdmissionDirection.COMPATIBLE ? null : direction;
}

function isCurrentProxySocket(ws: ProxySocket, registry: RelayRegistry): boolean {
  return ws.proxyId !== undefined && registry.getProxy(ws.proxyId) === ws;
}

// 处理代理端 WebSocket 连接生命周期
export function handleProxyConnection(
  ws: WebSocket,
  registry: RelayRegistry,
  logger: Logger,
  ptySnapshotRoutes: PtySnapshotRouteRegistry,
  sessionHistoryRoutes: SessionHistoryRouteRegistry,
  webPreviewRoutes: WebPreviewRouteRegistry,
  devicePreviewBridge: DevicePreviewBridge,
  chaos?: RelayChaos,
  remoteFileBridge?: RemoteFileBridge,
  proxyAdmissionTimeoutMs = DEFAULT_PROXY_ADMISSION_TIMEOUT_MS,
): void {
  const proxyWs = ws as ProxySocket;
  proxyWs.isAlive = true;
  proxyWs.admissionPhase = "awaiting";
  let registrationCompleted = false;
  let initialFrameReceived = false;
  const effectiveAdmissionTimeoutMs =
    Number.isSafeInteger(proxyAdmissionTimeoutMs) && proxyAdmissionTimeoutMs > 0
      ? proxyAdmissionTimeoutMs
      : DEFAULT_PROXY_ADMISSION_TIMEOUT_MS;
  let admissionTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    admissionTimeout = null;
    if (proxyWs.admissionPhase !== "awaiting" || proxyWs.readyState !== WebSocket.OPEN) return;
    proxyWs.admissionPhase = "rejected";
    logger.warn({ timeoutMs: effectiveAdmissionTimeoutMs }, "Proxy registration timed out");
    proxyWs.close(RETRYABLE_PROXY_ADMISSION_TIMEOUT_CLOSE_CODE, "proxy registration timeout");
  }, effectiveAdmissionTimeoutMs);
  admissionTimeout.unref?.();
  const clearAdmissionTimeout = (): void => {
    if (!admissionTimeout) return;
    clearTimeout(admissionTimeout);
    admissionTimeout = null;
  };

  proxyWs.on("pong", () => {
    proxyWs.isAlive = true;
  });

  proxyWs.on("message", (data: Buffer, isBinary: boolean) => {
    // Once the version-only bootstrap starts, this socket can never enter the application
    // protocol. In particular, queued traffic flushed by the source build is discarded.
    if (proxyWs.admissionPhase === "quarantined" || proxyWs.admissionPhase === "rejected") return;
    const isInitialFrame = !initialFrameReceived;
    initialFrameReceived = true;

    // Binary frames are pass-through; relay only reads the sessionId prefix for routing.
    if (isBinary) {
      if (!proxyWs.proxyId) {
        closeRejectedProxyProtocol(proxyWs, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH);
        return;
      }
      if (!isCurrentProxySocket(proxyWs, registry)) {
        logger.debug(
          { proxyId: proxyWs.proxyId },
          "Binary frame from superseded Proxy socket dropped",
        );
        return;
      }
      if (data.length < 2 || data.length > RELAY_BINARY_FRAME_MAX_BYTES) {
        logger.warn({ size: data.length }, "Binary frame rejected: invalid size");
        return;
      }
      if (proxyWs.proxyId && remoteFileBridge?.handleProxyBinary(proxyWs.proxyId, data)) {
        return;
      }
      const sessionIdLen = data[0];
      if (sessionIdLen === 0 || sessionIdLen > 255 || data.length < 1 + sessionIdLen) {
        logger.warn(
          { sessionIdLen, dataLen: data.length },
          "Binary frame rejected: malformed sessionId prefix",
        );
        return;
      }
      if (!proxyWs.proxyId) {
        logger.warn("Binary frame from unregistered proxy, dropped");
        return;
      }

      // Forward the original buffer, including the sessionId prefix, so clients receive exact PTY bytes.
      const clients = registry.getClientsForProxy(proxyWs.proxyId);
      for (const clientWs of clients) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: true, compress: false });
        }
      }
      return;
    }

    if (data.length > RELAY_JSON_MESSAGE_MAX_BYTES) {
      logger.warn(
        { size: data.length, proxyId: proxyWs.proxyId },
        "JSON message rejected: exceeds max size",
      );
      if (!proxyWs.proxyId) {
        closeRejectedProxyProtocol(proxyWs, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH);
      }
      return;
    }

    const raw = data.toString();
    const upgradeBootstrap = isInitialFrame
      ? parseProxyUpgradeBootstrapRequest(raw, RELAY_VERSION)
      : null;
    if (upgradeBootstrap) {
      proxyWs.admissionPhase = "quarantined";
      clearAdmissionTimeout();
      logger.info(
        {
          proxyId: upgradeBootstrap.proxyId,
          proxyVersion: upgradeBootstrap.proxyVersion,
          relayVersion: RELAY_VERSION,
        },
        "Proxy upgrade bootstrap sent",
      );
      sendProxyUpgradeBootstrapResponse(proxyWs, RELAY_VERSION);
      return;
    }

    if (isInitialFrame) {
      const rejection = classifyInitialProxyProtocol(raw);
      if (rejection) {
        logger.warn({ direction: rejection }, "Proxy control protocol rejected before admission");
        closeRejectedProxyProtocol(proxyWs, rejection);
        return;
      }
    }
    const result = parseMessage(raw);

    if (result.kind === "control" && result.message.type === "proxy_register") {
      if (registrationCompleted) {
        logger.warn(
          { proxyId: proxyWs.proxyId, requestedProxyId: result.message.proxyId },
          "Repeated Proxy registration on the same socket rejected",
        );
        closeRejectedProxyProtocol(proxyWs, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH);
        return;
      }
      const { proxyId, name, proxyVersion } = result.message;
      proxyWs.admissionPhase = "ready";
      clearAdmissionTimeout();
      const status = registry.registerProxy(proxyId, proxyWs, proxyVersion, name);
      proxyWs.proxyId = proxyId;
      registrationCompleted = true;
      const connectionId = devicePreviewBridge.registerProxyConnection(proxyId, proxyWs);
      if (status === "reconnected") {
        ptySnapshotRoutes.clearProxy(proxyId);
        sessionHistoryRoutes.clearProxy(proxyId);
        webPreviewRoutes.clearProxy(proxyId);
      }
      logger.info({ proxyId, proxyVersion, status }, "Proxy registered");

      proxyWs.send(
        serializeControl({
          type: "proxy_register_response",
          protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          status,
          relayVersion: RELAY_VERSION,
          connectionId,
        }),
      );

      if (status === "reconnected") {
        notifyClientsProxyOnline(proxyId, registry, logger, chaos);
      }

      broadcastProxyList(registry, chaos);
      return;
    }

    if (!proxyWs.proxyId) {
      // Pre-admission failures have exactly one authority: the stable close code and reason.
      // A versioned relay_error cannot be trusted by the peer that just failed admission.
      closeRejectedProxyProtocol(proxyWs, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH);
      return;
    }

    if (!isCurrentProxySocket(proxyWs, registry)) {
      logger.debug(
        { proxyId: proxyWs.proxyId, kind: result.kind },
        "Message from superseded Proxy socket dropped",
      );
      return;
    }

    if (result.kind === "control" && result.message.type === "proxy_disconnect") {
      if (proxyWs.proxyId) {
        ptySnapshotRoutes.clearProxy(proxyWs.proxyId);
        sessionHistoryRoutes.clearProxy(proxyWs.proxyId);
        webPreviewRoutes.clearProxy(proxyWs.proxyId);
        devicePreviewBridge.clearProxy(proxyWs.proxyId);
        notifyClientsProxyOffline(proxyWs.proxyId, registry, logger, chaos);
        registry.unregisterProxy(proxyWs.proxyId);
        logger.info(
          { proxyId: proxyWs.proxyId },
          "Proxy gracefully disconnected, resources cleaned",
        );
        proxyWs.proxyId = undefined;
        broadcastProxyList(registry, chaos);
      }
      return;
    }

    // proxy 重连后同步 session 列表，relay 据此建立 proxy-session 关联。
    if (result.kind === "control" && result.message.type === "session_sync") {
      if (!proxyWs.proxyId) return;
      const { sessions } = result.message;
      registry.setSessionsForProxy(
        proxyWs.proxyId,
        sessions.map((s) => s.id),
      );
      logger.info({ proxyId: proxyWs.proxyId, count: sessions.length }, "Session sync received");
      return;
    }

    if (result.kind === "control" && result.message.type === "latency_relay_proxy_pong") {
      if (!proxyWs.proxyId) {
        rejectNotRegistered(proxyWs);
        return;
      }
      const completed = completeRelayProxyLatencyProbe({
        proxyId: proxyWs.proxyId,
        requestId: result.message.requestId,
        logger,
      });
      if (!completed) {
        logger.debug(
          { proxyId: proxyWs.proxyId, requestId: result.message.requestId },
          "Unmatched relay-proxy latency pong ignored",
        );
      }
      return;
    }

    // proxy 发给 client 的控制消息：直接转发给绑定的客户端，不进 session buffer
    if (result.kind === "control") {
      if (isPreviewEventMessage(result.message) || isPreviewPushType(result.message.type)) {
        if (!proxyWs.proxyId) {
          rejectNotRegistered(proxyWs);
          return;
        }
        if (registry.getProxy(proxyWs.proxyId) !== proxyWs) {
          logger.debug(
            { proxyId: proxyWs.proxyId, type: result.message.type },
            "Preview push from superseded Proxy socket dropped",
          );
          return;
        }
        if (isPreviewPushType(result.message.type)) {
          logger.warn(
            { proxyId: proxyWs.proxyId, type: result.message.type },
            "Relay-scoped Preview push sent by Proxy was dropped",
          );
          return;
        }
        if (!isPreviewEventMessage(result.message)) return;
        if (result.message.type === "device_preview_removed_event") {
          devicePreviewBridge.handlePreviewRemovedEvent(
            proxyWs.proxyId,
            proxyWs,
            result.message.previewId,
          );
        }
        const clientCount = broadcastPreviewEvent(
          proxyWs.proxyId,
          proxyWs,
          result.message,
          registry,
          chaos,
        );
        logger.info(
          { proxyId: proxyWs.proxyId, type: result.message.type, clientCount },
          "Forwarded scoped Preview event to clients",
        );
        return;
      }
      // Device Preview has a Relay-owned management/data plane. Consume every device message
      // here so none can accidentally enter the generic Proxy-to-client broadcast path.
      if (result.message.type.startsWith("device_preview_")) {
        if (!proxyWs.proxyId) {
          rejectNotRegistered(proxyWs);
          return;
        }
        devicePreviewBridge.handleProxyControl(proxyWs.proxyId, proxyWs, result.message);
        return;
      }
      if (proxyWs.proxyId && result.message.type === "remote_file_stream_response") {
        remoteFileBridge?.handleProxyControl(proxyWs.proxyId, result.message);
        return;
      }
      if (proxyWs.proxyId && result.message.type === "remote_file_metadata_response") {
        remoteFileBridge?.handleProxyControl(proxyWs.proxyId, result.message);
        return;
      }
      if (proxyWs.proxyId && result.message.type === "remote_file_stream_complete") {
        remoteFileBridge?.handleProxyControl(proxyWs.proxyId, result.message);
        return;
      }
      if (proxyWs.proxyId && result.message.type === "remote_file_upload_stream_response") {
        remoteFileBridge?.handleProxyControl(proxyWs.proxyId, result.message);
        return;
      }
      if (proxyWs.proxyId && result.message.type === "session_snapshot") {
        const route = ptySnapshotRoutes.resolve(
          proxyWs.proxyId,
          result.message.sessionId,
          result.message.requestId,
          proxyWs,
        );
        if (route.kind === "matched" && route.clientWs.readyState === WebSocket.OPEN) {
          if (chaos) {
            chaos.send(route.clientWs, raw, {
              direction: "proxy_to_client",
              type: result.message.type,
            });
          } else {
            route.clientWs.send(raw);
          }
          return;
        }

        logger.debug(
          {
            proxyId: proxyWs.proxyId,
            sessionId: result.message.sessionId,
            requestId: result.message.requestId,
            route: route.kind,
          },
          "Unmatched PTY snapshot dropped",
        );
        return;
      }
      if (result.message.type === "session_history_response") {
        if (!proxyWs.proxyId) {
          rejectNotRegistered(proxyWs);
          return;
        }
        const route = sessionHistoryRoutes.resolve(
          proxyWs.proxyId,
          result.message.requestId,
          proxyWs,
        );
        if (route.kind === "matched") {
          let delivered = 0;
          for (const target of route.targets) {
            if (target.clientWs.readyState !== WebSocket.OPEN) continue;
            const response = serializeControl({
              ...result.message,
              requestId: target.requestId,
            });
            if (chaos) {
              chaos.send(target.clientWs, response, {
                direction: "proxy_to_client",
                type: result.message.type,
              });
            } else {
              target.clientWs.send(response);
            }
            delivered += 1;
          }
          logger.debug(
            {
              proxyId: proxyWs.proxyId,
              upstreamRequestId: result.message.requestId,
              waiterCount: route.targets.length,
              delivered,
              success: result.message.success,
            },
            "Session history response fanned out",
          );
          return;
        }

        logger.debug(
          {
            proxyId: proxyWs.proxyId,
            requestId: result.message.requestId,
            route: route.kind,
          },
          "Unmatched session history response dropped",
        );
        return;
      }
      if (isWebPreviewResponseMessage(result.message)) {
        if (!proxyWs.proxyId) {
          rejectNotRegistered(proxyWs);
          return;
        }
        const route = webPreviewRoutes.resolve(
          proxyWs.proxyId,
          result.message.requestId,
          result.message.type,
          proxyWs,
        );
        if (route.kind === "matched") {
          const isCurrentRoute = (): boolean =>
            registry.getProxy(proxyWs.proxyId!) === proxyWs &&
            registry.isCurrentClientBinding(route.clientId, route.clientWs, route.scope);
          if (route.clientWs.readyState !== WebSocket.OPEN || !isCurrentRoute()) {
            logger.debug(
              {
                proxyId: proxyWs.proxyId,
                requestId: result.message.requestId,
                type: result.message.type,
              },
              "Web Preview response for stale client binding dropped",
            );
            return;
          }
          const response = {
            ...result.message,
            requestId: route.clientRequestId,
            scope: route.scope,
          } as WebPreviewResponseMessage;
          const responseRaw = serializeControl(response);
          if (chaos) {
            chaos.send(route.clientWs, responseRaw, {
              direction: "proxy_to_client",
              type: result.message.type,
              guard: isCurrentRoute,
            });
          } else if (isCurrentRoute()) {
            route.clientWs.send(responseRaw);
          }
          return;
        }

        logger.debug(
          {
            proxyId: proxyWs.proxyId,
            requestId: result.message.requestId,
            type: result.message.type,
            route: route.kind,
            ...(route.kind === "response_type_mismatch"
              ? { expectedResponseType: route.expectedResponseType }
              : {}),
          },
          "Unmatched Web Preview response dropped",
        );
        return;
      }
      if (isProxyToClientRelayControlType(result.message.type)) {
        if (!proxyWs.proxyId) {
          rejectNotRegistered(proxyWs);
          return;
        }
        const clients = registry.getClientsForProxy(proxyWs.proxyId);
        for (const clientWs of clients) {
          if (clientWs.readyState === WebSocket.OPEN) {
            if (chaos) {
              chaos.send(clientWs, raw, {
                direction: "proxy_to_client",
                type: result.message.type,
              });
            } else {
              clientWs.send(raw);
            }
          }
        }
        logger.info(
          { proxyId: proxyWs.proxyId, type: result.message.type, clientCount: clients.length },
          "Forwarded control message from proxy to clients",
        );
        return;
      }
      // 其他控制消息代理端不应发送
      logger.warn({ type: result.message.type }, "Unexpected control message from proxy");
      return;
    }

    if (result.kind === "envelope") {
      if (!proxyWs.proxyId) {
        rejectNotRegistered(proxyWs);
        return;
      }
      routeProxyMessage(raw, proxyWs.proxyId, registry, logger, chaos);
      return;
    }

    if (result.kind === "invalid") {
      logger.error({ error: result.error, raw: raw.slice(0, 200) }, "Invalid message from proxy");
      proxyWs.send(
        JSON.stringify({
          type: "relay_error",
          code: RelayErrorCode.INVALID_MESSAGE,
          message: `${result.error} | raw: ${raw.slice(0, 200)}`,
        }),
      );
      return;
    }
  });

  proxyWs.on("close", (code: number, reason: Buffer) => {
    clearAdmissionTimeout();
    if (!proxyWs.proxyId) return;
    const closeMeta = { code, reason: reason.toString() || undefined };
    // 同 proxyId 重连场景：registerProxy 会 terminate 旧 ws、把 registry 指向新 ws，
    // 旧 ws 的 close 异步触发到达这里时，registry.getProxy(proxyId) 已是新 ws 实例。
    // 此时若仍执行 transitionProxy("online", "offline")，会把新连接的状态翻回离线并广播一次假离线。
    // 仅当 registry 当前持有的 ws 仍是我们自己（或 entry 已被 proxy_disconnect 清掉）时才走离线流程。
    const current = registry.getProxy(proxyWs.proxyId);
    if (current && current !== proxyWs) {
      logger.info(
        { proxyId: proxyWs.proxyId, ...closeMeta },
        "Old proxy ws closed after being superseded by reconnect, skipping offline transition",
      );
      return;
    }
    ptySnapshotRoutes.clearProxy(proxyWs.proxyId);
    sessionHistoryRoutes.clearProxy(proxyWs.proxyId);
    webPreviewRoutes.clearProxy(proxyWs.proxyId);
    devicePreviewBridge.clearProxy(proxyWs.proxyId);
    notifyClientsProxyOffline(proxyWs.proxyId, registry, logger, chaos);
    try {
      registry.transitionProxy(proxyWs.proxyId, "online", "offline");
    } catch (err) {
      // 期望路径: proxy_disconnect 已清理 entry, 或 entry 已 offline——transitionProxy 抛
      // "Proxy not found" / state mismatch。debug 级别记录 err 以便真有 FSM bug 时能定位。
      logger.debug(
        { proxyId: proxyWs.proxyId, err: String(err) },
        "transitionProxy on close skipped",
      );
    }
    logger.info(
      { proxyId: proxyWs.proxyId, ...closeMeta },
      "Proxy disconnected, state preserved for reconnect",
    );
    broadcastProxyList(registry, chaos);
  });

  proxyWs.on("error", (err) => {
    logger.error({ err, proxyId: proxyWs.proxyId }, "Proxy WebSocket error");
  });
}
