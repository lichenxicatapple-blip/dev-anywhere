import {
  compareProxyRelayProtocolVersions,
  ProxyProtocolAdmissionDirection,
  ProxyUpgradeBootstrapResponseSchema,
  RELAY_CONTROL_PROTOCOL_VERSION,
  type ProxyProtocolAdmissionDirectionType,
  type ProxyUpgradeBootstrapResponse,
} from "@dev-anywhere/shared";
import type { Logger } from "pino";

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INITIAL_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;

class InvalidRelayUpgradeBootstrapResponseError extends Error {}

export interface RelayUpgradeBootstrapAdmissionEvent {
  direction: ProxyProtocolAdmissionDirectionType;
  relayVersion?: string;
  relayControlProtocolVersion?: number;
}

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

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new InvalidRelayUpgradeBootstrapResponseError(
      "Relay upgrade bootstrap returned an invalid response",
    );
  }
  const parsed = ProxyUpgradeBootstrapResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRelayUpgradeBootstrapResponseError(
      "Relay upgrade bootstrap returned an invalid response",
    );
  }
  return parsed.data;
}

export interface RelayUpgradeBootstrapMonitor {
  request(): void;
  markControlProtocolConnected(): void;
  dispose(): void;
}

export function createRelayUpgradeBootstrapMonitor(options: {
  relayUrl: string;
  token?: string;
  logger: Logger;
  onAdmission: (event: RelayUpgradeBootstrapAdmissionEvent) => void;
  fetchImpl?: typeof fetch;
  controlProtocolVersion?: number;
  timeoutMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
}): RelayUpgradeBootstrapMonitor {
  const localControlProtocolVersion =
    typeof options.controlProtocolVersion === "number" &&
    Number.isSafeInteger(options.controlProtocolVersion) &&
    options.controlProtocolVersion > 0
      ? options.controlProtocolVersion
      : RELAY_CONTROL_PROTOCOL_VERSION;
  let disposed = false;
  let active = false;
  let inFlight: AbortController | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  let generation = 0;
  let lastPublishedKey: string | null = null;

  const clearRetry = (): void => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const suspend = (): void => {
    active = false;
    retryAttempt = 0;
    generation += 1;
    clearRetry();
    inFlight?.abort();
    inFlight = null;
  };

  const publish = (event: RelayUpgradeBootstrapAdmissionEvent): void => {
    const key = `${event.direction}:${event.relayVersion ?? ""}:${event.relayControlProtocolVersion ?? ""}`;
    if (lastPublishedKey === key) return;
    lastPublishedKey = key;
    options.onAdmission(event);
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
    const probeGeneration = generation;
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
        if (
          disposed ||
          !active ||
          controller.signal.aborted ||
          probeGeneration !== generation ||
          inFlight !== controller ||
          !bootstrap
        ) {
          return;
        }
        const direction = compareProxyRelayProtocolVersions(
          localControlProtocolVersion,
          bootstrap.controlProtocolVersion,
        );
        options.logger.info(
          {
            relayVersion: bootstrap.relayVersion,
            controlProtocolVersion: bootstrap.controlProtocolVersion,
            direction,
          },
          "Received Relay upgrade bootstrap",
        );
        publish({
          direction,
          relayVersion: bootstrap.relayVersion,
          relayControlProtocolVersion: bootstrap.controlProtocolVersion,
        });

        if (direction === ProxyProtocolAdmissionDirection.RELAY_OUTDATED) {
          // The local Proxy is newer. Keep this daemon alive, stop WebSocket churn in the
          // RelayConnection, and poll only this small stable endpoint until the Relay catches up.
          options.logger.warn(
            {
              localControlProtocolVersion,
              relayControlProtocolVersion: bootstrap.controlProtocolVersion,
            },
            "Relay control protocol is older; waiting for Relay update",
          );
          return;
        }

        // Compatible peers continue on WebSocket. A stale/invalid response and an older Proxy are
        // terminal for this process; auto-update has its own bounded retry lifecycle.
        active = false;
        retryAttempt = 0;
        clearRetry();
      })
      .catch((error: unknown) => {
        if (
          disposed ||
          !active ||
          controller.signal.aborted ||
          probeGeneration !== generation ||
          inFlight !== controller
        ) {
          return;
        }
        if (error instanceof InvalidRelayUpgradeBootstrapResponseError) {
          active = false;
          retryAttempt = 0;
          clearRetry();
          options.logger.error(
            { error: error.message },
            "Relay upgrade bootstrap protocol mismatch; retries stopped",
          );
          publish({ direction: ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH });
          return;
        }
        options.logger.debug(
          { error: error instanceof Error ? error.message : String(error) },
          "Relay upgrade bootstrap unavailable",
        );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (inFlight === controller) inFlight = null;
        if (probeGeneration === generation) scheduleRetry();
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
