import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { waitForCpolarTunnelReachability } from "./cpolar-tunnel-readiness.js";
import { terminateTunnelChild } from "./tunnel-child-termination.js";

const CPOLAR_URL_TIMEOUT_MS = 30_000;
const CPOLAR_REACHABILITY_TIMEOUT_MS = 45_000;
const CPOLAR_STOP_TIMEOUT_MS = 5_000;
export const CPOLAR_OUTPUT_LIMIT_BYTES = 64 * 1024;
const SIGNAL_SCAN_TAIL_CHARS = 512;

const CPOLAR_HTTPS_URL_PATTERN =
  /https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+cpolar\.(?:top|cn|io)(?=[/\s"']|$)/i;
const CPOLAR_OUTPUT_URL_PATTERN =
  /https?:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+cpolar\.(?:top|cn|io)(?=[/\s"']|$)/gi;

interface CpolarQuickTunnelOptions {
  cpolarBin: string;
  originUrl: string;
  tunnelName: string;
  env?: NodeJS.ProcessEnv;
  urlTimeoutMs?: number;
  reachabilityTimeoutMs?: number;
  spawn?: typeof spawn;
  waitForReachability?: typeof waitForCpolarTunnelReachability;
}

export interface CpolarQuickTunnel {
  child: ChildProcess;
  publicUrl: Promise<string>;
  publicReady: Promise<string>;
  getOutput: () => string;
  stop: () => Promise<void>;
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

function appendOutputTail(current: string, chunk: string): string {
  const bytes = Buffer.from(current + chunk);
  if (bytes.length <= CPOLAR_OUTPUT_LIMIT_BYTES) return bytes.toString("utf8");
  let start = bytes.length - CPOLAR_OUTPUT_LIMIT_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function redactOutput(output: string): string {
  return appendOutputTail(
    "",
    output
      .replace(CPOLAR_OUTPUT_URL_PATTERN, "[cpolar URL redacted]")
      .replace(/(\bauthtoken\b\s*[=:]\s*)\S+/gi, "$1[redacted]"),
  );
}

function processFailure(error: unknown): Error {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  if (code === "ENOENT") return new Error("cpolar was not found. Install cpolar and retry.");
  return new Error(
    typeof code === "string" && /^E[A-Z0-9_]{1,31}$/.test(code)
      ? `cpolar process failed (${code})`
      : "cpolar process failed",
  );
}

function originPort(originUrl: string): string {
  const parsed = new URL(originUrl);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("cpolar origin must be an HTTP 127.0.0.1 URL with an explicit port");
  }
  return parsed.port;
}

function safeTunnelName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
  if (!normalized) throw new Error("cpolar tunnel name is empty");
  return normalized;
}

export function extractCpolarHttpsUrl(output: string): string | null {
  return output.match(CPOLAR_HTTPS_URL_PATTERN)?.[0] ?? null;
}

export function cpolarFailureMessage(output: string): string | null {
  if (
    /登录实例.*(?:超过|限制)|online (?:process|instance).*limit|too many (?:sessions|clients)|maximum.*(?:sessions|clients|instances)|limit(?:ed)?.*simultaneous.*(?:sessions|clients|instances|processes)/i.test(
      output,
    )
  ) {
    return "Cpolar 在线进程已达账号上限";
  }
  if (/authtoken|authentication|认证(?:失败|错误)|尚未.*登录|not authenticated/i.test(output)) {
    return "Cpolar 尚未完成账号认证";
  }
  return null;
}

export async function terminateCpolarChild(child: ChildProcess | null): Promise<void> {
  // cpolar tears down the public route on the same interrupt used by its documented Ctrl+C flow.
  await terminateTunnelChild(child, {
    processName: "cpolar",
    gracefulSignal: "SIGINT",
    gracefulTimeoutMs: CPOLAR_STOP_TIMEOUT_MS,
  });
}

export function startCpolarQuickTunnel(options: CpolarQuickTunnelOptions): CpolarQuickTunnel {
  const args = [
    "http",
    `-tunnelName=${safeTunnelName(options.tunnelName)}`,
    "-region=cn_top",
    "-inspect-addr=127.0.0.1:0",
    "-dashboard=off",
    "-daemon=off",
    "-processMode=single",
    "-proto=https",
    "-log=stdout",
    "-log-level=INFO",
    originPort(options.originUrl),
  ];
  const spawnOptions: SpawnOptions = {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const child = (options.spawn ?? spawn)(options.cpolarBin, args, spawnOptions);
  const urlTimeoutMs = options.urlTimeoutMs ?? CPOLAR_URL_TIMEOUT_MS;
  const publicUrlSignal = createTimedSignal<string>(
    urlTimeoutMs,
    `cpolar did not provide a public HTTPS URL within ${urlTimeoutMs / 1000}s`,
  );
  void publicUrlSignal.promise.catch(() => undefined);

  const readinessAbort = new AbortController();
  const publicReady = publicUrlSignal.promise.then(async (publicUrl) => {
    await (options.waitForReachability ?? waitForCpolarTunnelReachability)({
      publicUrl,
      signal: readinessAbort.signal,
      timeoutMs: options.reachabilityTimeoutMs ?? CPOLAR_REACHABILITY_TIMEOUT_MS,
    });
    return publicUrl;
  });
  void publicReady.catch(() => undefined);

  let output = "";
  const scanTails = { stdout: "", stderr: "" };
  const inspect = (source: keyof typeof scanTails, chunk: string | Buffer) => {
    const text = chunk.toString();
    const scan = scanTails[source] + text;
    scanTails[source] = scan.slice(-SIGNAL_SCAN_TAIL_CHARS);
    output = appendOutputTail(output, text);
    const url = extractCpolarHttpsUrl(scan);
    if (url) publicUrlSignal.resolve(url);
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string | Buffer) => inspect("stdout", chunk));
  child.stderr?.on("data", (chunk: string | Buffer) => inspect("stderr", chunk));
  child.once("error", (error) => {
    readinessAbort.abort();
    publicUrlSignal.reject(processFailure(error));
  });
  child.once("exit", (code, signal) => {
    readinessAbort.abort();
    publicUrlSignal.reject(
      new Error(`cpolar exited before providing a public URL (code=${code}, signal=${signal})`),
    );
  });

  let stopPromise: Promise<void> | null = null;
  return {
    child,
    publicUrl: publicUrlSignal.promise,
    publicReady,
    getOutput: () => redactOutput(output),
    stop: () => {
      if (!stopPromise) {
        readinessAbort.abort();
        publicUrlSignal.reject(new Error("cpolar stopped before providing a public URL"));
        stopPromise = terminateCpolarChild(child).catch((error: unknown) => {
          stopPromise = null;
          throw error;
        });
      }
      return stopPromise;
    },
  };
}
