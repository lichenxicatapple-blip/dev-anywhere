import {
  ProxyUpgradeBootstrapResponseSchema,
  RELAY_CONTROL_PROTOCOL_VERSION,
  type ProxyUpgradeBootstrapResponse,
} from "@dev-anywhere/shared";
import type { Logger } from "pino";

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INITIAL_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;

export function relayUpgradeBootstrapUrl(relayUrl: string): URL {
  const url = new URL(relayUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new Error(`Unsupported Relay URL protocol: ${url.protocol}`);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/proxy-upgrade-bootstrap`;
  url.search = "";
  url.hash = "";
  return url;
}

export async function fetchRelayUpgradeBootstrap(options: {
  relayUrl: string;
  token?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ProxyUpgradeBootstrapResponse | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = options.token ? { authorization: `Bearer ${options.token}` } : undefined;
  const response = await fetchImpl(relayUpgradeBootstrapUrl(options.relayUrl), {
    headers,
    redirect: "error",
    cache: "no-store",
    signal: options.signal,
  });
  // Relays released before this bootstrap endpoint continue through their WebSocket registration
  // path. Same-protocol rolling updates therefore remain available while this channel rolls out.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Relay upgrade bootstrap returned HTTP ${response.status}`);

  const parsed = ProxyUpgradeBootstrapResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Relay upgrade bootstrap returned an invalid response");
  return parsed.data;
}

interface RelayUpgradeBootstrapMonitor {
  request(): void;
  markControlProtocolConnected(): void;
  dispose(): void;
}

export function createRelayUpgradeBootstrapMonitor(options: {
  relayUrl: string;
  token?: string;
  logger: Logger;
  onVersion: (version: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
}): RelayUpgradeBootstrapMonitor {
  let disposed = false;
  let active = false;
  let inFlight: AbortController | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;

  const clearRetry = (): void => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const suspend = (): void => {
    active = false;
    retryAttempt = 0;
    clearRetry();
    inFlight?.abort();
    inFlight = null;
  };

  const scheduleRetry = (): void => {
    if (disposed || !active || inFlight || retryTimer) return;
    const initial = options.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS;
    const maximum = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    const delay = Math.min(initial * 2 ** Math.min(retryAttempt, 30), maximum);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      probe();
    }, delay);
    retryTimer.unref?.();
  };

  const probe = (): void => {
    if (disposed || !active || inFlight) return;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    );
    timeout.unref?.();
    inFlight = controller;

    void fetchRelayUpgradeBootstrap({
      relayUrl: options.relayUrl,
      token: options.token,
      signal: controller.signal,
      fetchImpl: options.fetchImpl,
    })
      .then((bootstrap) => {
        if (disposed || !active || !bootstrap) return;
        active = false;
        retryAttempt = 0;
        clearRetry();
        options.logger.info(
          {
            relayVersion: bootstrap.relayVersion,
            controlProtocolVersion: bootstrap.controlProtocolVersion,
          },
          "Received Relay upgrade bootstrap",
        );
        options.onVersion(bootstrap.relayVersion);
        if (bootstrap.controlProtocolVersion !== RELAY_CONTROL_PROTOCOL_VERSION) {
          options.logger.warn(
            {
              localControlProtocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
              relayControlProtocolVersion: bootstrap.controlProtocolVersion,
            },
            "Relay control protocol differs; waiting for Proxy update",
          );
        }
      })
      .catch((error: unknown) => {
        if (disposed || !active || controller.signal.aborted) return;
        options.logger.debug(
          { error: error instanceof Error ? error.message : String(error) },
          "Relay upgrade bootstrap unavailable",
        );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (inFlight === controller) inFlight = null;
        scheduleRetry();
      });
  };

  return {
    request() {
      if (disposed) return;
      if (!active) {
        active = true;
        retryAttempt = 0;
      }
      if (!retryTimer) probe();
    },
    markControlProtocolConnected() {
      suspend();
    },
    dispose() {
      disposed = true;
      suspend();
    },
  };
}
