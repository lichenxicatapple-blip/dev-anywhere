import { Resolver } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { probePreviewTunnelEdge } from "./quick-tunnel-readiness.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_INTERVAL_MS = 500;
const DNS_TIMEOUT_MS = 2_000;
const CPOLAR_PUBLIC_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+cpolar\.(?:top|cn|io)$/i;

type ResolveAddresses = (hostname: string, signal: AbortSignal) => Promise<string[]>;
type ProbeAddress = (hostname: string, address: string, signal: AbortSignal) => Promise<boolean>;

interface CpolarTunnelReachabilityOptions {
  publicUrl: string;
  signal: AbortSignal;
  timeoutMs?: number;
  retryIntervalMs?: number;
  resolveAddresses?: ResolveAddresses;
  probeAddress?: ProbeAddress;
}

function cancelledError(): Error {
  return new Error("cpolar tunnel readiness cancelled");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledError();
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    throwIfAborted(signal);
    return [
      ...new Set(results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))),
    ];
  } catch (error) {
    if (signal.aborted) throw cancelledError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function waitForCpolarTunnelReachability(
  options: CpolarTunnelReachabilityOptions,
): Promise<void> {
  const parsed = new URL(options.publicUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    !CPOLAR_PUBLIC_HOST_PATTERN.test(parsed.hostname)
  ) {
    throw new Error("cpolar provided an invalid public tunnel URL");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const resolveAddresses = options.resolveAddresses ?? resolvePublicAddresses;
  const probeAddress = options.probeAddress ?? probePreviewTunnelEdge;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    try {
      const addresses = await resolveAddresses(parsed.hostname, options.signal);
      for (const address of addresses) {
        if (await probeAddress(parsed.hostname, address, options.signal)) return;
      }
    } catch {
      throwIfAborted(options.signal);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      await sleep(Math.min(retryIntervalMs, remainingMs), undefined, {
        signal: options.signal,
      });
    } catch {
      throw cancelledError();
    }
  }

  throw new Error(`cpolar tunnel did not become reachable within ${timeoutMs / 1000}s`);
}
