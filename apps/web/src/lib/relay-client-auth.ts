export type RelayClientAuthIssue = "missing_client_token" | "invalid_client_token";

interface RelayHealthResponse {
  status?: string;
  auth?: {
    clientTokenRequired?: boolean;
  };
}

function endpointUrl(relayUrl: string, path: string): string {
  return new URL(path, relayUrl || window.location.origin).toString();
}

export async function checkRelayClientAuth(
  relayUrl: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<RelayClientAuthIssue | null> {
  const healthRes = await fetch(endpointUrl(relayUrl, "/health"), {
    cache: "no-store",
    signal,
  });
  if (!healthRes.ok) {
    throw new Error(`Relay health check failed: HTTP ${healthRes.status}`);
  }
  const health = (await healthRes.json()) as RelayHealthResponse;
  if (!health.auth?.clientTokenRequired) return null;
  if (!token) return "missing_client_token";

  const authRes = await fetch(endpointUrl(relayUrl, "/auth/client"), {
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
