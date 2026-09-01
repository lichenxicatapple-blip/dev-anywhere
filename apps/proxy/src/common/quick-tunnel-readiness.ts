import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const TRY_CLOUDFLARE_ZONE = "trycloudflare.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 500;
const DNS_TIMEOUT_MS = 2_000;
const HTTPS_PROBE_TIMEOUT_MS = 5_000;

export const PREVIEW_HEALTH_PATH = "/.well-known/dev-anywhere-preview-health";
export const PREVIEW_HEALTH_HEADER = "x-dev-anywhere-preview-health";
export const PREVIEW_HEALTH_MARKER = "1";

type ResolveEdgeAddresses = (hostname: string, signal: AbortSignal) => Promise<string[]>;
type ProbeEdgeAddress = (
  hostname: string,
  address: string,
  signal: AbortSignal,
) => Promise<boolean>;

interface QuickTunnelReachabilityOptions {
  publicUrl: string;
  signal: AbortSignal;
  timeoutMs?: number;
  retryIntervalMs?: number;
  resolveEdgeAddresses?: ResolveEdgeAddresses;
  probeEdgeAddress?: ProbeEdgeAddress;
}

function cancelledError(): Error {
  return new Error("Quick Tunnel readiness cancelled");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledError();
}

async function withResolver<T>(
  resolver: Resolver,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await operation();
  } catch (error) {
    if (signal.aborted) throw cancelledError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function uniqueAddresses(results: PromiseSettledResult<string[]>[]): string[] {
  return [
    ...new Set(results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))),
  ];
}

async function discoverAuthoritativeServers(signal: AbortSignal): Promise<string[]> {
  const recursive = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  const names = await withResolver(recursive, signal, () =>
    recursive.resolveNs(TRY_CLOUDFLARE_ZONE),
  );
  const addressResults = await Promise.allSettled(
    names.flatMap((name) => [
      withResolver(recursive, signal, () => recursive.resolve4(name)),
      withResolver(recursive, signal, () => recursive.resolve6(name)),
    ]),
  );
  throwIfAborted(signal);
  const addresses = uniqueAddresses(addressResults);
  if (addresses.length === 0) throw new Error("Quick Tunnel authoritative DNS unavailable");
  return addresses;
}

export function createQuickTunnelAuthoritativeResolver(): ResolveEdgeAddresses {
  let authoritativeServers: string[] | undefined;
  return async (hostname, signal) => {
    authoritativeServers ??= await discoverAuthoritativeServers(signal);
    const authoritative = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
    authoritative.setServers(authoritativeServers);
    const results = await Promise.allSettled([
      withResolver(authoritative, signal, () => authoritative.resolve4(hostname)),
      withResolver(authoritative, signal, () => authoritative.resolve6(hostname)),
    ]);
    throwIfAborted(signal);
    return uniqueAddresses(results);
  };
}

export function probePreviewTunnelEdge(
  hostname: string,
  address: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let settled = false;
    const finish = (error: Error | null, reachable = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal.aborted) reject(cancelledError());
      else if (error) reject(error);
      else resolve(reachable);
    };
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      reject(new Error("Tunnel DNS returned an invalid address"));
      return;
    }
    const req = request({
      protocol: "https:",
      hostname,
      servername: hostname,
      port: 443,
      method: "GET",
      path: PREVIEW_HEALTH_PATH,
      agent: false,
      signal,
      lookup: (_name, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      headers: { Host: hostname, Connection: "close" },
    });
    const timer = setTimeout(() => {
      req.destroy(new Error("Tunnel health probe timed out"));
    }, HTTPS_PROBE_TIMEOUT_MS);
    timer.unref?.();
    req.once("response", (response) => {
      const reachable =
        response.statusCode === 204 &&
        response.headers[PREVIEW_HEALTH_HEADER] === PREVIEW_HEALTH_MARKER;
      response.resume();
      response.once("end", () => finish(null, reachable));
      response.once("error", (error) => finish(error));
    });
    req.once("error", (error) => finish(error));
    req.end();
  });
}

export async function waitForQuickTunnelReachability(
  options: QuickTunnelReachabilityOptions,
): Promise<void> {
  const hostname = new URL(options.publicUrl).hostname;
  if (!hostname.endsWith(`.${TRY_CLOUDFLARE_ZONE}`)) {
    throw new Error("cloudflared provided an invalid Quick Tunnel URL");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const resolveEdgeAddresses =
    options.resolveEdgeAddresses ?? createQuickTunnelAuthoritativeResolver();
  const probeEdgeAddress = options.probeEdgeAddress ?? probePreviewTunnelEdge;
  const attemptAbort = new AbortController();
  const cancelAttempt = () => attemptAbort.abort();
  options.signal.addEventListener("abort", cancelAttempt, { once: true });
  const timeout = setTimeout(() => attemptAbort.abort(), timeoutMs);
  timeout.unref?.();
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      try {
        const addresses = await resolveEdgeAddresses(hostname, attemptAbort.signal);
        for (const address of addresses) {
          if (await probeEdgeAddress(hostname, address, attemptAbort.signal)) return;
        }
      } catch {
        throwIfAborted(options.signal);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || attemptAbort.signal.aborted) break;
      try {
        await sleep(Math.min(retryIntervalMs, remainingMs), undefined, {
          signal: attemptAbort.signal,
        });
      } catch {
        throwIfAborted(options.signal);
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", cancelAttempt);
  }

  throwIfAborted(options.signal);
  throw new Error(`Quick Tunnel did not become reachable within ${timeoutMs / 1000}s`);
}
