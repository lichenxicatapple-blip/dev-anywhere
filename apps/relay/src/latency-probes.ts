import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { serializeControl, type ControlMessage } from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { RelayChaos } from "./chaos.js";

const DEFAULT_RELAY_PROXY_PROBE_TIMEOUT_MS = 3_000;

interface RelayProxyProbe {
  proxyId: string;
  requestId: string;
  clientWs: WebSocket;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  chaos?: RelayChaos;
}

const pendingRelayProxyProbes = new Map<string, RelayProxyProbe>();

function keyFor(proxyId: string, requestId: string): string {
  return `${proxyId}:${requestId}`;
}

function sendClientResponse(
  clientWs: WebSocket,
  response: ControlMessage<"latency_relay_proxy_response">,
  chaos?: RelayChaos,
): void {
  if (clientWs.readyState !== WebSocket.OPEN) return;
  const raw = serializeControl(response);
  if (chaos) {
    chaos.send(clientWs, raw, {
      direction: "proxy_to_client",
      type: "latency_relay_proxy_response",
    });
    return;
  }
  clientWs.send(raw);
}

export function startRelayProxyLatencyProbe({
  requestId,
  proxyId,
  proxyWs,
  clientWs,
  logger,
  chaos,
  timeoutMs = DEFAULT_RELAY_PROXY_PROBE_TIMEOUT_MS,
}: {
  requestId: string;
  proxyId: string;
  proxyWs: WebSocket;
  clientWs: WebSocket;
  logger: Logger;
  chaos?: RelayChaos;
  timeoutMs?: number;
}): void {
  const key = keyFor(proxyId, requestId);
  const existing = pendingRelayProxyProbes.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    pendingRelayProxyProbes.delete(key);
  }

  const startedAt = performance.now();
  const timer = setTimeout(() => {
    pendingRelayProxyProbes.delete(key);
    sendClientResponse(
      clientWs,
      {
        type: "latency_relay_proxy_response",
        requestId,
        success: false,
        error: "Relay 到开发机测速超时",
      },
      chaos,
    );
    logger.warn({ proxyId, requestId }, "Relay-proxy latency probe timed out");
  }, timeoutMs);

  pendingRelayProxyProbes.set(key, {
    proxyId,
    requestId,
    clientWs,
    startedAt,
    timer,
    chaos,
  });

  const raw = serializeControl({
    type: "latency_relay_proxy_ping",
    requestId,
    relayNow: Date.now(),
  });
  if (chaos) {
    chaos.send(proxyWs, raw, { direction: "client_to_proxy", type: "latency_relay_proxy_ping" });
    return;
  }
  proxyWs.send(raw);
}

export function completeRelayProxyLatencyProbe({
  proxyId,
  requestId,
  logger,
}: {
  proxyId: string;
  requestId: string;
  logger: Logger;
}): boolean {
  const key = keyFor(proxyId, requestId);
  const pending = pendingRelayProxyProbes.get(key);
  if (!pending) return false;

  pendingRelayProxyProbes.delete(key);
  clearTimeout(pending.timer);
  const rttMs = performance.now() - pending.startedAt;

  sendClientResponse(
    pending.clientWs,
    {
      type: "latency_relay_proxy_response",
      requestId,
      success: true,
      rttMs,
    },
    pending.chaos,
  );
  logger.debug({ proxyId, requestId, rttMs }, "Relay-proxy latency probe completed");
  return true;
}
