import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { waitForQuickTunnelReachability } from "./quick-tunnel-readiness.js";
import { terminateTunnelChild } from "./tunnel-child-termination.js";

const CLOUDFLARED_URL_TIMEOUT_MS = 30_000;
const CLOUDFLARED_CONNECTION_TIMEOUT_MS = 45_000;
const CLOUDFLARED_REACHABILITY_TIMEOUT_MS = 60_000;
export const CLOUDFLARED_OUTPUT_LIMIT_BYTES = 64 * 1024;
const CLOUDFLARED_STOP_TIMEOUT_MS = 5_000;
const SIGNAL_SCAN_TAIL_CHARS = 256;

const TRY_CLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const TRY_CLOUDFLARE_OUTPUT_PATTERN = /(?:https:\/\/)?[a-z0-9-]+\.trycloudflare\.com\b/gi;
const REGISTERED_CONNECTION_MARKER = "Registered tunnel connection";

interface CloudflaredQuickTunnelOptions {
  cloudflaredBin: string;
  originUrl: string;
  configPath: string;
  pidFilePath?: string;
  env?: NodeJS.ProcessEnv;
  urlTimeoutMs?: number;
  connectionTimeoutMs?: number;
  reachabilityTimeoutMs?: number;
  spawn?: typeof spawn;
  waitForReachability?: typeof waitForQuickTunnelReachability;
}

export interface CloudflaredQuickTunnel {
  child: ChildProcess;
  publicUrl: Promise<string>;
  connectionReady: Promise<void>;
  publicReady: Promise<string>;
  getOutput: () => string;
  stop: () => Promise<void>;
}

export function extractTryCloudflareUrl(output: string): string | null {
  return output.match(TRY_CLOUDFLARE_URL_PATTERN)?.[0] ?? null;
}

function appendOutputTail(current: string, chunk: string): string {
  const combined = current + chunk;
  const bytes = Buffer.from(combined);
  if (bytes.length <= CLOUDFLARED_OUTPUT_LIMIT_BYTES) return combined;
  let start = bytes.length - CLOUDFLARED_OUTPUT_LIMIT_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function redactOutput(output: string): string {
  return appendOutputTail(
    "",
    output.replace(TRY_CLOUDFLARE_OUTPUT_PATTERN, "[trycloudflare URL redacted]"),
  );
}

interface TimedSignal<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function createTimedSignal<T>(timeoutMs: number, timeoutMessage: string): TimedSignal<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectPromise(new Error(timeoutMessage));
  }, timeoutMs);

  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    },
  };
}

function processFailure(error: unknown): Error {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  if (code === "ENOENT") {
    return new Error("cloudflared was not found. Install cloudflared and retry.");
  }
  return new Error(
    typeof code === "string" && /^E[A-Z0-9_]{1,31}$/.test(code)
      ? `cloudflared process failed (${code})`
      : "cloudflared process failed",
  );
}

export async function terminateCloudflaredChild(child: ChildProcess | null): Promise<void> {
  await terminateTunnelChild(child, {
    processName: "cloudflared",
    gracefulSignal: "SIGTERM",
    gracefulTimeoutMs: CLOUDFLARED_STOP_TIMEOUT_MS,
  });
}

export function startCloudflaredQuickTunnel(
  options: CloudflaredQuickTunnelOptions,
): CloudflaredQuickTunnel {
  const args = [
    "tunnel",
    "--config",
    options.configPath,
    "--no-autoupdate",
    "--grace-period",
    "2s",
    "--protocol",
    "auto",
    "--url",
    options.originUrl,
    "--loglevel",
    "info",
    ...(options.pidFilePath ? ["--pidfile", options.pidFilePath] : []),
  ];
  const spawnOptions: SpawnOptions = {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const child = (options.spawn ?? spawn)(options.cloudflaredBin, args, spawnOptions);

  const urlTimeoutMs = options.urlTimeoutMs ?? CLOUDFLARED_URL_TIMEOUT_MS;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? CLOUDFLARED_CONNECTION_TIMEOUT_MS;
  const publicUrlSignal = createTimedSignal<string>(
    urlTimeoutMs,
    `cloudflared did not provide a trycloudflare.com URL within ${urlTimeoutMs / 1000}s`,
  );
  const connectionSignal = createTimedSignal<void>(
    connectionTimeoutMs,
    `cloudflared did not register a tunnel connection within ${connectionTimeoutMs / 1000}s`,
  );
  // Some consumers only need one signal. Mark both promises handled without changing what awaiters see.
  void publicUrlSignal.promise.catch(() => undefined);
  void connectionSignal.promise.catch(() => undefined);
  const readinessAbort = new AbortController();
  let publicReadyPromise: Promise<string> | null = null;
  const getPublicReady = () => {
    publicReadyPromise ??= Promise.all([publicUrlSignal.promise, connectionSignal.promise]).then(
      async ([publicUrl]) => {
        await (options.waitForReachability ?? waitForQuickTunnelReachability)({
          publicUrl,
          signal: readinessAbort.signal,
          timeoutMs: options.reachabilityTimeoutMs ?? CLOUDFLARED_REACHABILITY_TIMEOUT_MS,
        });
        return publicUrl;
      },
    );
    void publicReadyPromise.catch(() => undefined);
    return publicReadyPromise;
  };

  let output = "";
  const scanTails = { stdout: "", stderr: "" };
  const inspect = (source: keyof typeof scanTails, chunk: string | Buffer) => {
    const text = chunk.toString();
    const scan = scanTails[source] + text;
    scanTails[source] = scan.slice(-SIGNAL_SCAN_TAIL_CHARS);
    output = appendOutputTail(output, text);

    const url = extractTryCloudflareUrl(scan);
    if (url) publicUrlSignal.resolve(url);
    if (scan.includes(REGISTERED_CONNECTION_MARKER)) connectionSignal.resolve();
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string | Buffer) => inspect("stdout", chunk));
  child.stderr?.on("data", (chunk: string | Buffer) => inspect("stderr", chunk));
  child.once("error", (error) => {
    readinessAbort.abort();
    const failure = processFailure(error);
    publicUrlSignal.reject(failure);
    connectionSignal.reject(failure);
  });
  child.once("exit", (code, signal) => {
    readinessAbort.abort();
    publicUrlSignal.reject(
      new Error(
        `cloudflared exited before providing a tunnel URL (code=${code}, signal=${signal})`,
      ),
    );
    connectionSignal.reject(
      new Error(
        `cloudflared exited before registering a tunnel connection (code=${code}, signal=${signal})`,
      ),
    );
  });

  let stopPromise: Promise<void> | null = null;

  return {
    child,
    publicUrl: publicUrlSignal.promise,
    connectionReady: connectionSignal.promise,
    get publicReady() {
      return getPublicReady();
    },
    getOutput: () => redactOutput(output),
    stop: () => {
      if (!stopPromise) {
        readinessAbort.abort();
        publicUrlSignal.reject(new Error("cloudflared stopped before providing a tunnel URL"));
        connectionSignal.reject(
          new Error("cloudflared stopped before registering a tunnel connection"),
        );
        stopPromise = terminateCloudflaredChild(child).catch((error: unknown) => {
          stopPromise = null;
          throw error;
        });
      }
      return stopPromise;
    },
  };
}
