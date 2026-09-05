import {
  compareRelayControlProtocol,
  type RelayProtocolIssue,
} from "@/lib/relay-protocol-admission";

export type RelayClientAuthIssue = "missing_client_token" | "invalid_client_token";
export type RelayClientPreflightIssue = RelayClientAuthIssue | RelayProtocolIssue;

interface RelayHealthResponse {
  status?: string;
  controlProtocolVersion?: unknown;
  auth?: {
    clientTokenRequired?: boolean;
  };
}

function endpointUrl(relayUrl: string, path: string): string {
  return new URL(path, relayUrl || window.location.origin).toString();
}

export async function checkRelayClientPreflight(
  relayUrl: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<RelayClientPreflightIssue | null> {
  const healthRes = await fetch(endpointUrl(relayUrl, "/health"), {
    cache: "no-store",
    signal,
  });
  if (!healthRes.ok) {
    throw new Error(`Relay health check failed: HTTP ${healthRes.status}`);
  }
  const health = (await healthRes.json()) as RelayHealthResponse;
  if (health.controlProtocolVersion === undefined) {
    // A Relay without the admission version field predates this stable preflight contract.
    return "service_outdated";
  }
  if (
    typeof health.controlProtocolVersion !== "number" ||
    !Number.isSafeInteger(health.controlProtocolVersion) ||
    health.controlProtocolVersion <= 0
  ) {
    return "protocol_mismatch";
  }
  const protocolIssue = compareRelayControlProtocol(health.controlProtocolVersion);
  if (protocolIssue) {
    return protocolIssue;
  }
  if (!health.auth?.clientTokenRequired) return null;
  if (!token) return "missing_client_token";

  const authRes = await fetch(endpointUrl(relayUrl, "/api/auth/client"), {
    cache: "no-store",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (authRes.status === 401) return "invalid_client_token";
  if (!authRes.ok) {
    throw new Error(`Relay client auth check failed: HTTP ${authRes.status}`);
  }
  return null;
}
