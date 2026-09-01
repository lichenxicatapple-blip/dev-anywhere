import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startCpolarQuickTunnel } from "#src/common/cpolar-quick-tunnel.js";
import { startPreviewGateway } from "#src/serve/preview/preview-gateway.js";
import { PREVIEW_GATEWAY_MARKER_HEADER } from "#src/serve/preview/preview-response-headers.js";
import {
  captureCpolarRuntimeProcessIdentity,
  cleanupStalePreviewRuntimes,
  serializePreviewRuntimeMarker,
} from "#src/serve/preview/stale-preview-runtime.js";

const REAL_CPOLAR_ENABLED = process.env.DEV_ANYWHERE_REAL_CPOLAR_PREVIEW === "1";
const READY_TIMEOUT_MS = 90_000;
const INVALIDATION_TIMEOUT_MS = 30_000;

type Cleanup = () => void | Promise<void>;
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
  if (errors.length > 0) throw new AggregateError(errors, "real cpolar cleanup failed");
}, 30_000);

async function requireCpolarBin(): Promise<string> {
  const command = process.env.DEV_ANYWHERE_CPOLAR_BIN;
  if (!command || !isAbsolute(command)) {
    throw new Error("DEV_ANYWHERE_CPOLAR_BIN must be an absolute cpolar executable path");
  }
  await access(command, fsConstants.X_OK);
  return command;
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
    await sleep(500);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`${description} timed out${suffix}`);
}

async function publicResponse(base: string, path: string): Promise<Response> {
  const target = new URL(path, base);
  target.searchParams.set("__dev_anywhere_e2e", randomUUID());
  return fetch(target, {
    redirect: "manual",
    cache: "no-store",
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not determine local test server port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function waitForWebSocketOpen(webSocket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("public WebSocket open timed out")), 20_000);
    webSocket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    webSocket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function exchangeWebSocketMessage(webSocket: WebSocket, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("public WebSocket echo timed out")), 10_000);
    webSocket.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    webSocket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    webSocket.send(message);
  });
}

describe.skipIf(!REAL_CPOLAR_ENABLED).sequential("real cpolar web preview tunnel", () => {
  it("serves a static multi-page site and invalidates the address after stop", async () => {
    const cpolarBin = await requireCpolarBin();
    const root = await mkdtemp(join(tmpdir(), "dev-anywhere-real-cpolar-static-"));
    registerCleanup(() => rm(root, { recursive: true, force: true }));
    const siteRoot = join(root, "site");
    await mkdir(siteRoot);
    const indexMarker = `cpolar-index-${randomUUID()}`;
    const aboutMarker = `cpolar-about-${randomUUID()}`;
    await Promise.all([
      writeFile(
        join(siteRoot, "index.html"),
        `<!doctype html><a href="/about.html">${indexMarker}</a>`,
      ),
      writeFile(join(siteRoot, "about.html"), `<!doctype html><h1>${aboutMarker}</h1>`),
    ]);

    const gateway = await startPreviewGateway({
      source: {
        kind: "static",
        rootPath: await realpath(siteRoot),
        entryPath: "index.html",
      },
    });
    registerCleanup(() => gateway.close());
    const tunnel = startCpolarQuickTunnel({
      cpolarBin,
      originUrl: gateway.originUrl,
      tunnelName: `dev_anywhere_e2e_${randomUUID().replaceAll("-", "")}`,
      env: process.env,
      reachabilityTimeoutMs: READY_TIMEOUT_MS,
    });
    registerCleanup(() => tunnel.stop());
    const processIdentity = await captureCpolarRuntimeProcessIdentity(tunnel.child.pid!);
    expect(processIdentity).not.toBeNull();
    const publicBase = await tunnel.publicReady;
    expect(await captureCpolarRuntimeProcessIdentity(tunnel.child.pid!)).toEqual(processIdentity);

    const [index, about] = await Promise.all([
      publicResponse(publicBase, "/index.html"),
      publicResponse(publicBase, "/about.html"),
    ]);
    expect(index.status).toBe(200);
    expect(index.headers.get(PREVIEW_GATEWAY_MARKER_HEADER)).toBe("1");
    expect(await index.text()).toContain(indexMarker);
    expect(about.status).toBe(200);
    expect(await about.text()).toContain(aboutMarker);

    const staleRoot = join(root, "stale-runtimes");
    const runtimeDir = join(staleRoot, "preview-1");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      join(runtimeDir, "runtime.json"),
      serializePreviewRuntimeMarker(tunnel.child.pid!, {
        provider: "cpolar",
        ...processIdentity!,
      }),
    );
    await cleanupStalePreviewRuntimes(staleRoot);
    await expect(access(runtimeDir)).rejects.toThrow();
    await pollUntil(
      "stopped cpolar address invalidation",
      async () => {
        try {
          const response = await publicResponse(publicBase, "/index.html");
          return (
            response.status !== 200 || response.headers.get(PREVIEW_GATEWAY_MARKER_HEADER) !== "1"
          );
        } catch {
          return true;
        }
      },
      INVALIDATION_TIMEOUT_MS,
    );
  }, 180_000);

  it("proxies public WebSocket traffic to a local website", async () => {
    const cpolarBin = await requireCpolarBin();
    const webSockets = new WebSocketServer({ noServer: true });
    const upstream = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("local website");
    });
    upstream.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/hmr") {
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("error", () => undefined);
        webSocket.on("message", (message) => webSocket.send(message));
      });
    });
    const port = await listen(upstream);
    registerCleanup(async () => {
      for (const webSocket of webSockets.clients) webSocket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await closeServer(upstream);
    });

    const gateway = await startPreviewGateway({
      source: { kind: "local", url: `http://localhost:${port}/` },
      localHost: "127.0.0.1",
    });
    registerCleanup(() => gateway.close());
    const tunnel = startCpolarQuickTunnel({
      cpolarBin,
      originUrl: gateway.originUrl,
      tunnelName: `dev_anywhere_e2e_${randomUUID().replaceAll("-", "")}`,
      env: process.env,
      reachabilityTimeoutMs: READY_TIMEOUT_MS,
    });
    registerCleanup(() => tunnel.stop());
    const publicBase = await tunnel.publicReady;
    const webSocketUrl = new URL("/hmr", publicBase);
    webSocketUrl.protocol = "wss:";
    const webSocket = new WebSocket(webSocketUrl);
    webSocket.on("error", () => undefined);
    registerCleanup(() => webSocket.terminate());

    await waitForWebSocketOpen(webSocket);
    const marker = `cpolar-ws-${randomUUID()}`;
    await expect(exchangeWebSocketMessage(webSocket, marker)).resolves.toBe(marker);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        webSocket.terminate();
        resolve();
      }, 5_000);
      webSocket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      webSocket.close(1000);
    });
  }, 180_000);
});
