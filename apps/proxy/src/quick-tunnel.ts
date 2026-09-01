import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger, flushLogger } from "@dev-anywhere/shared/logger";
import { createRelayServer, type RelayServer } from "@dev-anywhere/relay/server";
import { WebSocket } from "ws";
import { spawnScript } from "./common/env.js";
import {
  extractTryCloudflareUrl,
  startCloudflaredQuickTunnel,
  terminateCloudflaredChild,
} from "./common/cloudflared-quick-tunnel.js";
import { createQuickTunnelAuthoritativeResolver } from "./common/quick-tunnel-readiness.js";

const QUICK_TUNNEL_PROFILE = "quick-tunnel";
const PUBLIC_READINESS_TIMEOUT_MS = 45_000;
const PROXY_READINESS_TIMEOUT_MS = 15_000;

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface QuickTunnelOptions {
  cloudflaredBin?: string;
}

export { extractTryCloudflareUrl };

export function buildQuickTunnelAccessUrl(publicUrl: string, clientToken: string): string {
  const url = new URL(publicUrl);
  url.hash = `/?relayToken=${encodeURIComponent(clientToken)}`;
  return url.toString();
}

function collectCommand(child: ChildProcess): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runProfileCommand(
  action: "start" | "stop",
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const child = spawnScript("index", ["--profile", QUICK_TUNNEL_PROFILE, "serve", action], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    unref: false,
  });
  return collectCommand(child);
}

function startCloudflared(
  cloudflaredBin: string,
  originUrl: string,
  configPath: string,
): {
  child: ChildProcess;
  publicUrl: Promise<string>;
  getOutput: () => string;
} {
  const tunnel = startCloudflaredQuickTunnel({ cloudflaredBin, originUrl, configPath });
  return {
    child: tunnel.child,
    publicUrl: tunnel.publicUrl,
    getOutput: tunnel.getOutput,
  };
}

async function waitForProxy(relay: RelayServer): Promise<void> {
  const deadline = Date.now() + PROXY_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const proxyId = relay.registry
      .listProxies()
      .find((candidate) => relay.registry.isProxyOnline(candidate));
    if (proxyId) return;
    await sleep(200);
  }
  throw new Error("The temporary Proxy did not connect to the local Relay");
}

async function probePublicWebSocket(publicUrl: string, clientToken: string): Promise<void> {
  const wsUrl = new URL("/client", publicUrl);
  wsUrl.protocol = "wss:";
  wsUrl.searchParams.set("token", clientToken);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { origin: publicUrl });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("public WebSocket probe timed out"));
    }, 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForPublicEndpoint(publicUrl: string, clientToken: string): Promise<void> {
  const deadline = Date.now() + PUBLIC_READINESS_TIMEOUT_MS;
  let lastError: unknown;
  const hostname = new URL(publicUrl).hostname;
  const resolveAuthoritativeAddresses = createQuickTunnelAuthoritativeResolver();
  const dnsSignal = new AbortController().signal;

  while (Date.now() < deadline) {
    try {
      const addresses = await resolveAuthoritativeAddresses(hostname, dnsSignal);
      if (addresses.length > 0) break;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }

  while (Date.now() < deadline) {
    try {
      const [health, page] = await Promise.all([
        fetch(new URL("/health", publicUrl), { signal: AbortSignal.timeout(5_000) }),
        fetch(new URL("/", publicUrl), { signal: AbortSignal.timeout(5_000) }),
      ]);
      if (!health.ok) throw new Error(`public health returned HTTP ${health.status}`);
      if (!page.ok) throw new Error(`public Web UI returned HTTP ${page.status}`);
      const html = await page.text();
      if (!html.includes("<!doctype html>")) {
        throw new Error("public root did not return the Web UI");
      }
      await probePublicWebSocket(publicUrl, clientToken);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw new Error(
    `Quick Tunnel did not become ready: ${
      lastError instanceof Error
        ? `${lastError.message}${
            lastError.cause instanceof Error ? ` (${lastError.cause.message})` : ""
          }`
        : String(lastError)
    }`,
  );
}

function waitUntilStopped(cloudflared: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (result: "signal" | "exit", code?: number | null, signal?: string | null) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      cloudflared.off("exit", onExit);
      if (result === "signal") {
        resolve();
        return;
      }
      reject(new Error(`cloudflared stopped unexpectedly (code=${code}, signal=${signal})`));
    };
    const onSignal = () => finish("signal");
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish("exit", code, signal);

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    cloudflared.once("exit", onExit);
  });
}

export async function runQuickTunnel(options: QuickTunnelOptions = {}): Promise<void> {
  const proxyToken = randomBytes(24).toString("hex");
  const clientToken = randomBytes(24).toString("hex");
  const quickDir = join(homedir(), ".dev-anywhere", "profiles", QUICK_TUNNEL_PROFILE);
  mkdirSync(quickDir, { recursive: true });
  const cloudflaredConfigPath = join(quickDir, "cloudflared-quick.yml");
  writeFileSync(cloudflaredConfigPath, "{}\n");

  const logger = createLogger({
    name: "quick-tunnel-relay",
    level: "warn",
    stdout: true,
  });
  const relay = createRelayServer({
    logger,
    dataDir: join(quickDir, "relay-data"),
    proxyToken,
    clientToken,
  });

  let cloudflared: ChildProcess | null = null;
  let proxyStarted = false;
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (proxyStarted) {
      await runProfileCommand("stop", process.env).catch(() => undefined);
    }
    await terminateCloudflaredChild(cloudflared);
    await relay.close().catch(() => undefined);
    await flushLogger(logger);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      relay.httpServer.once("error", reject);
      relay.httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = relay.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine the temporary Relay port");
    }
    const originUrl = `http://127.0.0.1:${address.port}`;
    const tunnel = startCloudflared(
      options.cloudflaredBin ?? "cloudflared",
      originUrl,
      cloudflaredConfigPath,
    );
    cloudflared = tunnel.child;
    const publicUrl = await tunnel.publicUrl;

    const proxyEnv = {
      ...process.env,
      RELAY_URL: originUrl.replace(/^http:/, "ws:"),
      RELAY_PROXY_TOKEN: proxyToken,
    };
    await runProfileCommand("stop", proxyEnv);
    const startResult = await runProfileCommand("start", proxyEnv);
    if (startResult.code !== 0) {
      throw new Error(
        `Unable to start the temporary Proxy:\n${(
          startResult.stderr || startResult.stdout
        ).trim()}`,
      );
    }
    proxyStarted = true;

    await waitForProxy(relay);
    try {
      await waitForPublicEndpoint(publicUrl, clientToken);
    } catch (error) {
      const cloudflaredOutput = tunnel.getOutput().trim();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${
          cloudflaredOutput ? `\n\ncloudflared output:\n${cloudflaredOutput}` : ""
        }`,
        { cause: error },
      );
    }

    const accessUrl = buildQuickTunnelAccessUrl(publicUrl, clientToken);
    console.log("");
    console.log("DEV Anywhere Quick Tunnel is ready");
    console.log(`URL:          ${accessUrl}`);
    console.log(`Client token: ${clientToken}`);
    console.log("");
    console.log("Keep this command running. Press Ctrl+C to stop the temporary tunnel.");
    console.log("Quick Tunnels are intended for evaluation, not production deployment.");

    await waitUntilStopped(cloudflared);
  } finally {
    await cleanup();
  }
}
