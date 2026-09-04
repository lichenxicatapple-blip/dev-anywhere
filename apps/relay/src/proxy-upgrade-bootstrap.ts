import { IdSchema } from "@dev-anywhere/shared";
import type { WebSocket } from "ws";
import { z } from "zod";

const UPGRADE_BOOTSTRAP_SOURCE_VERSION = "0.8.1";
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const ProxyUpgradeBootstrapRequestSchema = z
  .object({
    type: z.literal("proxy_register"),
    proxyId: IdSchema,
    name: z.string().optional(),
    proxyVersion: z.literal(UPGRADE_BOOTSTRAP_SOURCE_VERSION),
  })
  .strict();

type ProxyUpgradeBootstrapRequest = z.infer<typeof ProxyUpgradeBootstrapRequestSchema>;

function parseStableVersion(value: string): readonly [number, number, number] | null {
  const match = STABLE_VERSION_RE.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function isLowerStableVersion(source: string, target: string): boolean {
  const left = parseStableVersion(source);
  const right = parseStableVersion(target);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

// This is deliberately outside RelayControlSchema: the current control schema remains the only
// way to register and exchange application traffic. This narrow bootstrap can only tell the
// released source build which exact Relay package version it should install.
export function parseProxyUpgradeBootstrapRequest(
  raw: string,
  relayVersion: string,
): ProxyUpgradeBootstrapRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const request = ProxyUpgradeBootstrapRequestSchema.safeParse(parsed);
  if (!request.success) return null;
  if (!isLowerStableVersion(request.data.proxyVersion, relayVersion)) return null;
  return request.data;
}

export function sendProxyUpgradeBootstrapResponse(ws: WebSocket, relayVersion: string): void {
  // Keep the authenticated socket open in its caller-owned quarantine until the updater replaces
  // the source daemon. Closing here would reset that daemon's reconnect counter after every
  // response and create a tight reconnect loop when automatic updates are disabled or unavailable.
  ws.send(
    JSON.stringify({
      type: "proxy_register_response",
      status: "new",
      relayVersion,
    }),
    (error) => {
      if (error) ws.terminate();
    },
  );
}
