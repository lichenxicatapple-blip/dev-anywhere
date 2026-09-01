import { randomUUID } from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  startCloudflaredQuickTunnel,
  type CloudflaredQuickTunnel,
} from "#src/common/cloudflared-quick-tunnel.js";
import { startPreviewGateway, type PreviewGateway } from "#src/serve/preview/preview-gateway.js";
import { PREVIEW_GATEWAY_MARKER_HEADER } from "#src/serve/preview/preview-response-headers.js";

const REAL_TUNNEL_ENABLED = process.env.DEV_ANYWHERE_REAL_WEB_PREVIEW === "1";
const READY_TIMEOUT_MS = 90_000;
const INVALIDATION_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_PUBLIC_RESPONSE_BYTES = 1024 * 1024;

type Cleanup = () => void | Promise<void>;

interface PublicResponse {
  status: number;
  headers: Headers;
  body: string;
}

interface PublicRequestOptions {
  headers?: Record<string, string>;
  redirect?: "manual";
}

interface PublicNetwork {
  agent?: HttpsProxyAgent<string>;
}

const cleanups: Cleanup[] = [];

function registerCleanup(cleanup: Cleanup): void {
  cleanups.push(cleanup);
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "real preview E2E cleanup failed");
}, 45_000);

function redactTryCloudflareUrls(value: string): string {
  let redacted = value;
  for (const proxyUrl of [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]) {
    if (!proxyUrl) continue;
    redacted = redacted.split(proxyUrl).join("<proxy>");
    try {
      const parsed = new URL(proxyUrl);
      redacted = redacted.split(parsed.host).join("<proxy-host>");
    } catch {
      // Invalid proxy configuration is reported without echoing its value.
    }
  }
  redacted = redacted.replace(/\b(https?):\/\/[^\s/@]+@/gi, "$1://***@");
  const mask = (label: string) => {
    const masked =
      label.length > 6 ? `${label.slice(0, 3)}***${label.slice(-3)}` : `${label[0] ?? "*"}***`;
    return `${masked}.trycloudflare.com`;
  };
  return redacted.replace(
    /\b(?:(https?|wss):\/\/)?([a-z0-9-]+)\.trycloudflare\.com\b/gi,
    (_match, protocol: string | undefined, label: string) =>
      `${protocol ? `${protocol}://` : ""}${mask(label)}`,
  );
}

function maskedTunnelHost(publicUrl: string): string {
  return redactTryCloudflareUrls(publicUrl).replace(/^https:\/\//, "");
}

function errorDiagnostic(error: Error): string {
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const causeCode = typeof cause?.code === "string" ? ` [${cause.code}]` : "";
  const causeMessage = typeof cause?.message === "string" ? `: ${cause.message}` : "";
  return redactTryCloudflareUrls(`${error.message}${causeCode}${causeMessage}`);
}

async function requireCloudflaredBin(): Promise<string> {
  const cloudflaredBin = process.env.DEV_ANYWHERE_CLOUDFLARED_BIN;
  if (!cloudflaredBin) {
    throw new Error(
      "DEV_ANYWHERE_CLOUDFLARED_BIN must point to an absolute cloudflared executable",
    );
  }
  if (!isAbsolute(cloudflaredBin)) {
    throw new Error("DEV_ANYWHERE_CLOUDFLARED_BIN must be an absolute path");
  }
  await access(cloudflaredBin, fsConstants.X_OK);
  return cloudflaredBin;
}

async function makeIsolatedRuntime(prefix: string): Promise<{
  root: string;
  configPath: string;
  pidFilePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  registerCleanup(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "cloudflared.yml");
  await writeFile(configPath, "{}\n", { mode: 0o600 });
  return { root, configPath, pidFilePath: join(root, "cloudflared.pid") };
}

function minimalCloudflaredEnv(cloudflaredBin: string, runtimeRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(cloudflaredBin)}:/usr/bin:/bin`,
    HOME: runtimeRoot,
    USERPROFILE: runtimeRoot,
    TMPDIR: runtimeRoot,
    TMP: runtimeRoot,
    TEMP: runtimeRoot,
    PWD: runtimeRoot,
    XDG_CONFIG_HOME: join(runtimeRoot, "xdg-config"),
    XDG_CACHE_HOME: join(runtimeRoot, "xdg-cache"),
    XDG_DATA_HOME: join(runtimeRoot, "xdg-data"),
    LANG: "C",
    LC_ALL: "C",
  };
}

function createPublicNetwork(): PublicNetwork {
  const proxyUrl =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!proxyUrl) return {};
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error("public preview E2E proxy URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("public preview E2E proxy must use http:// or https://");
  }
  const agent = new HttpsProxyAgent(proxyUrl);
  registerCleanup(() => agent.destroy());
  return { agent };
}

function startRealTunnel(
  cloudflaredBin: string,
  gateway: PreviewGateway,
  runtime: { root: string; configPath: string; pidFilePath: string },
): CloudflaredQuickTunnel {
  const spawnInRuntime = ((
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {},
  ) => spawn(command, args, { ...options, cwd: runtime.root })) as unknown as typeof spawn;
  const tunnel = startCloudflaredQuickTunnel({
    cloudflaredBin,
    originUrl: gateway.originUrl,
    configPath: runtime.configPath,
    pidFilePath: runtime.pidFilePath,
    env: minimalCloudflaredEnv(cloudflaredBin, runtime.root),
    urlTimeoutMs: 60_000,
    spawn: spawnInRuntime,
  });
  registerCleanup(() => tunnel.stop());
  return tunnel;
}

function withNonce(url: string | URL, base?: string): URL {
  const result = new URL(url, base);
  result.searchParams.set("__dev_anywhere_e2e", randomUUID());
  return result;
}

async function fetchPublic(
  network: PublicNetwork,
  publicBase: string,
  pathOrUrl: string,
  options: PublicRequestOptions = {},
): Promise<PublicResponse> {
  const target = withNonce(pathOrUrl, publicBase);
  if (target.protocol !== "https:") throw new Error("public preview request must use HTTPS");

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: PublicResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const request = httpsRequest(
      target,
      {
        agent: network.agent,
        method: "GET",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_PUBLIC_RESPONSE_BYTES) {
            response.destroy(new Error("public preview response exceeded 1 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", (error) => finish(error));
        response.once("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers as IncomingHttpHeaders)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          finish(undefined, {
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error("public preview request timed out"));
    }, REQUEST_TIMEOUT_MS);
    request.once("error", (error) => finish(error));
    request.end();
  });
}

async function pollUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const suffix = lastError instanceof Error ? `: ${errorDiagnostic(lastError)}` : "";
  throw new Error(`${description} timed out${suffix}`);
}

async function waitForPublicPreview(
  network: PublicNetwork,
  publicBase: string,
  path: string,
  expectedBodyMarker: string,
): Promise<void> {
  await pollUntil(
    "public preview readiness",
    async () => {
      const response = await fetchPublic(network, publicBase, path, { redirect: "manual" });
      return (
        response.status >= 200 &&
        response.status < 400 &&
        response.headers.get(PREVIEW_GATEWAY_MARKER_HEADER) === "1" &&
        response.body.includes(expectedBodyMarker)
      );
    },
    READY_TIMEOUT_MS,
  );
}

async function waitForPublicPreviewInvalidation(
  network: PublicNetwork,
  publicBase: string,
  path: string,
  previousBodyMarker: string,
): Promise<void> {
  let consecutiveInvalidResponses = 0;
  await pollUntil(
    "stopped public preview invalidation",
    async () => {
      try {
        const response = await fetchPublic(network, publicBase, path, { redirect: "manual" });
        const invalid =
          response.headers.get(PREVIEW_GATEWAY_MARKER_HEADER) !== "1" ||
          response.status < 200 ||
          response.status >= 400 ||
          !response.body.includes(previousBodyMarker);
        consecutiveInvalidResponses = invalid ? consecutiveInvalidResponses + 1 : 0;
      } catch {
        consecutiveInvalidResponses += 1;
      }
      return consecutiveInvalidResponses >= 3;
    },
    INVALIDATION_TIMEOUT_MS,
  );
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not determine local test server port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForWebSocketOpen(webSocket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      if (webSocket.readyState === WebSocket.CONNECTING) webSocket.terminate();
      reject(new Error("public WebSocket open timed out"));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      webSocket.off("open", onOpen);
      webSocket.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(redactTryCloudflareUrls(error.message)));
    };
    webSocket.once("open", onOpen);
    webSocket.once("error", onError);
  });
}

function exchangeWebSocketMessage(webSocket: WebSocket, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("public WebSocket echo timed out"));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      webSocket.off("message", onMessage);
      webSocket.off("error", onError);
      webSocket.off("close", onClose);
    };
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      resolve(data.toString());
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(redactTryCloudflareUrls(error.message)));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("public WebSocket closed before echo response"));
    };
    webSocket.once("message", onMessage);
    webSocket.once("error", onError);
    webSocket.once("close", onClose);
    try {
      webSocket.send(message);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function waitForWebSocketClose(webSocket: WebSocket): Promise<void> {
  if (webSocket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("public WebSocket did not close after tunnel stop"));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      webSocket.off("close", onClose);
      webSocket.off("error", onExpectedError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onExpectedError = () => {
      // cloudflared shutdown can surface an error before the expected close event.
    };
    webSocket.once("close", onClose);
    webSocket.on("error", onExpectedError);
  });
}

describe.skipIf(!REAL_TUNNEL_ENABLED).sequential("real Cloudflare web preview tunnel", () => {
  it("serves a static multi-page site and invalidates its URL after stop", async () => {
    const cloudflaredBin = await requireCloudflaredBin();
    const runtime = await makeIsolatedRuntime("dev-anywhere-real-preview-static-");
    const network = createPublicNetwork();
    const siteRoot = join(runtime.root, "site");
    await mkdir(join(siteRoot, "assets"), { recursive: true });

    const indexMarker = `static-index-${randomUUID()}`;
    const aboutMarker = `static-about-${randomUUID()}`;
    const scriptMarker = `static-script-${randomUUID()}`;
    await Promise.all([
      writeFile(
        join(siteRoot, "index.html"),
        `<!doctype html><a href="/about.html">${indexMarker}</a>`,
      ),
      writeFile(join(siteRoot, "about.html"), `<!doctype html><h1>${aboutMarker}</h1>`),
      writeFile(
        join(siteRoot, "assets", "app.js"),
        `globalThis.marker=${JSON.stringify(scriptMarker)}`,
      ),
    ]);

    const gateway = await startPreviewGateway({
      source: {
        kind: "static",
        rootPath: await realpath(siteRoot),
        entryPath: "index.html",
      },
    });
    registerCleanup(() => gateway.close());
    const tunnel = startRealTunnel(cloudflaredBin, gateway, runtime);
    const publicBase = await tunnel.publicReady;
    console.info(`[real-web-preview] static tunnel: ${maskedTunnelHost(publicBase)}`);

    await waitForPublicPreview(network, publicBase, "/index.html", indexMarker);
    const [index, about, script, missing] = await Promise.all([
      fetchPublic(network, publicBase, "/index.html"),
      fetchPublic(network, publicBase, "/about.html"),
      fetchPublic(network, publicBase, "/assets/app.js"),
      fetchPublic(network, publicBase, "/missing-route", {
        headers: { Accept: "text/html" },
        redirect: "manual",
      }),
    ]);

    expect(index.status).toBe(200);
    expect(index.body).toContain(indexMarker);
    expect(index.body).toContain('href="/about.html"');
    expect(index.headers.get(PREVIEW_GATEWAY_MARKER_HEADER)).toBe("1");
    expect(index.headers.get("cache-control")).toContain("no-store");
    expect(index.headers.get("x-robots-tag")).toContain("noindex");
    expect(about.status).toBe(200);
    expect(about.body).toContain(aboutMarker);
    expect(script.status).toBe(200);
    expect(script.body).toContain(scriptMarker);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(missing.status).toBe(404);
    expect(missing.headers.get(PREVIEW_GATEWAY_MARKER_HEADER)).toBe("1");

    await tunnel.stop();
    expect(tunnel.child.exitCode !== null || tunnel.child.signalCode !== null).toBe(true);
    await waitForPublicPreviewInvalidation(network, publicBase, "/index.html", indexMarker);
    await gateway.close();
  }, 360_000);

  it("rewrites local redirects, proxies WebSocket traffic and invalidates both after stop", async () => {
    const cloudflaredBin = await requireCloudflaredBin();
    const runtime = await makeIsolatedRuntime("dev-anywhere-real-preview-local-");
    const network = createPublicNetwork();
    const nextMarker = `local-next-${randomUUID()}`;
    const upstreamWebSockets = new WebSocketServer({ noServer: true });
    let upstreamPort = 0;
    const upstream = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/start") {
        response.statusCode = 302;
        response.setHeader("Location", `http://localhost:${upstreamPort}/next?from=absolute`);
        response.end();
        return;
      }
      if (url.pathname === "/next") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(nextMarker);
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    upstream.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/hmr") {
        socket.destroy();
        return;
      }
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("error", () => undefined);
        webSocket.on("message", (message) => webSocket.send(message));
      });
    });
    upstreamPort = await listen(upstream);
    registerCleanup(async () => {
      for (const webSocket of upstreamWebSockets.clients) webSocket.terminate();
      await new Promise<void>((resolve) => upstreamWebSockets.close(() => resolve()));
      await closeServer(upstream);
    });

    const gateway = await startPreviewGateway({
      source: { kind: "local", url: `http://localhost:${upstreamPort}/start` },
      localHost: "127.0.0.1",
    });
    registerCleanup(() => gateway.close());
    const tunnel = startRealTunnel(cloudflaredBin, gateway, runtime);
    const publicBase = await tunnel.publicReady;
    console.info(`[real-web-preview] local tunnel: ${maskedTunnelHost(publicBase)}`);

    await waitForPublicPreview(network, publicBase, "/start", "");
    const redirect = await fetchPublic(network, publicBase, "/start", { redirect: "manual" });
    const location = redirect.headers.get("location");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get(PREVIEW_GATEWAY_MARKER_HEADER)).toBe("1");
    expect(location).not.toBeNull();
    const redirectedUrl = new URL(location!);
    const tunnelUrl = new URL(publicBase);
    expect(redirectedUrl.protocol === "https:").toBe(true);
    expect(redirectedUrl.host === tunnelUrl.host).toBe(true);
    expect(redirectedUrl.pathname).toBe("/next");
    expect(redirectedUrl.searchParams.get("from")).toBe("absolute");

    const followed = await fetchPublic(network, publicBase, redirectedUrl.toString());
    expect(followed.status).toBe(200);
    expect(followed.headers.get(PREVIEW_GATEWAY_MARKER_HEADER)).toBe("1");
    expect(followed.body).toContain(nextMarker);

    const webSocketUrl = new URL("/hmr", publicBase);
    webSocketUrl.protocol = "wss:";
    const publicWebSocket = new WebSocket(webSocketUrl, {
      origin: publicBase,
      agent: network.agent,
    });
    publicWebSocket.on("error", () => undefined);
    registerCleanup(() => {
      if (publicWebSocket.readyState !== WebSocket.CLOSED) publicWebSocket.terminate();
    });
    await waitForWebSocketOpen(publicWebSocket);
    const webSocketMarker = `hmr-${randomUUID()}`;
    await expect(exchangeWebSocketMessage(publicWebSocket, webSocketMarker)).resolves.toBe(
      webSocketMarker,
    );

    const webSocketClosed = waitForWebSocketClose(publicWebSocket);
    await tunnel.stop();
    expect(tunnel.child.exitCode !== null || tunnel.child.signalCode !== null).toBe(true);
    await webSocketClosed;
    await waitForPublicPreviewInvalidation(network, publicBase, "/next", nextMarker);
    await gateway.close();
  }, 360_000);
});
