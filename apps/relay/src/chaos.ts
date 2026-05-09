import { WebSocket } from "ws";
import type { Logger } from "@dev-anywhere/shared";

export type RelayChaosDirection = "client_to_proxy" | "proxy_to_client";

export interface RelayChaosOptions {
  enabled: boolean;
  delayMs: number;
  duplicate: boolean;
  duplicateDelayMs: number;
  reorder: boolean;
  reorderDelayMs: number;
  types: Set<string> | undefined;
}

export interface RelayChaosMeta {
  direction: RelayChaosDirection;
  type: string;
}

export interface RelayChaos {
  send(ws: WebSocket, data: string | Buffer, meta: RelayChaosMeta): void;
}

export function parseRelayChaosFromEnv(env: NodeJS.ProcessEnv): RelayChaosOptions {
  const enabled = env.DEV_ANYWHERE_RELAY_CHAOS === "1";
  const types = env.DEV_ANYWHERE_RELAY_CHAOS_TYPES?.split(",")
    .map((type) => type.trim())
    .filter(Boolean);

  return {
    enabled,
    delayMs: parseInt(env.DEV_ANYWHERE_RELAY_CHAOS_DELAY_MS ?? "0", 10),
    duplicate: env.DEV_ANYWHERE_RELAY_CHAOS_DUPLICATE === "1",
    duplicateDelayMs: parseInt(env.DEV_ANYWHERE_RELAY_CHAOS_DUPLICATE_DELAY_MS ?? "10", 10),
    reorder: env.DEV_ANYWHERE_RELAY_CHAOS_REORDER === "1",
    reorderDelayMs: parseInt(env.DEV_ANYWHERE_RELAY_CHAOS_REORDER_DELAY_MS ?? "40", 10),
    types: types && types.length > 0 ? new Set(types) : undefined,
  };
}

export function createRelayChaos(options: RelayChaosOptions, logger: Logger): RelayChaos {
  let sequence = 0;

  function shouldAffect(meta: RelayChaosMeta): boolean {
    if (!options.enabled) return false;
    if (options.types && !options.types.has(meta.type)) return false;
    return true;
  }

  function sendNow(ws: WebSocket, data: string | Buffer): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }

  return {
    send(ws, data, meta) {
      if (!shouldAffect(meta)) {
        sendNow(ws, data);
        return;
      }

      sequence += 1;
      const reorderDelay = options.reorder && sequence % 2 === 1 ? options.reorderDelayMs : 0;
      const delayMs = Math.max(0, options.delayMs + reorderDelay);

      logger.warn(
        { direction: meta.direction, type: meta.type, delayMs, duplicate: options.duplicate },
        "Relay chaos forwarding message",
      );

      setTimeout(() => sendNow(ws, data), delayMs);

      if (options.duplicate) {
        setTimeout(() => sendNow(ws, data), delayMs + options.duplicateDelayMs);
      }
    },
  };
}
