import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, realpath, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  PREVIEW_HEALTH_HEADER,
  PREVIEW_HEALTH_MARKER,
  PREVIEW_HEALTH_PATH,
} from "#src/common/quick-tunnel-readiness.js";
import { startPreviewGateway, type PreviewGateway } from "#src/serve/preview/preview-gateway.js";
import { inspectStaticPreviewPath } from "#src/serve/preview/static-preview.js";

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("missing address"));
      else resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestGateway(
  gateway: PreviewGateway,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const url = new URL(gateway.originUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()));
});

describe("static web preview gateway", () => {
  it("blocks content immediately while retaining its origin port until close", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-anywhere-preview-deactivate-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "index.html"), "private preview content");
    const gateway = await startPreviewGateway({
      source: { kind: "static", rootPath: await realpath(root), entryPath: "index.html" },
    });
    cleanup.push(() => gateway.close());
    const port = Number(new URL(gateway.originUrl).port);

    expect((await requestGateway(gateway, "/index.html")).body.toString()).toBe(
      "private preview content",
    );
    gateway.deactivate();
    expect(await requestGateway(gateway, "/index.html")).toMatchObject({
      status: 410,
      body: Buffer.alloc(0),
    });
    expect((await requestGateway(gateway, PREVIEW_HEALTH_PATH)).status).toBe(410);

    const prematureReuse = createServer();
    await expect(
      new Promise<void>((resolve, reject) => {
        prematureReuse.once("error", reject);
        prematureReuse.listen(port, "127.0.0.1", resolve);
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    await gateway.close();
    const replacement = createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(port, "127.0.0.1", resolve);
    });
    cleanup.push(() => closeServer(replacement));
  });

  it("serves MIME, HEAD and ranges with noindex/no-store headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-anywhere-preview-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "index.html"), "<!doctype html><h1>Hello</h1>");
    const canonicalRoot = await realpath(root);
    const gateway = await startPreviewGateway({
      source: { kind: "static", rootPath: canonicalRoot, entryPath: "index.html" },
    });
    cleanup.push(() => gateway.close());

    const health = await requestGateway(gateway, PREVIEW_HEALTH_PATH);
    expect(health).toMatchObject({ status: 204, body: Buffer.alloc(0) });
    expect(health.headers[PREVIEW_HEALTH_HEADER]).toBe(PREVIEW_HEALTH_MARKER);
    expect(health.headers["cache-control"]).toBe("no-store");

    const range = await requestGateway(gateway, "/index.html", {
      headers: { Range: "bytes=0-3" },
    });
    expect(range.status).toBe(206);
    expect(range.body.toString()).toBe("<!do");
    expect(range.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(range.headers["content-range"]).toMatch(/^bytes 0-3\//);
    expect(range.headers["x-robots-tag"]).toContain("noindex");
    expect(range.headers["cache-control"]).toContain("no-store");

    const head = await requestGateway(gateway, "/index.html", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
  });

  it("enables document fallback only for a directory containing only index.html", async () => {
    const singleIndex = await mkdtemp(join(tmpdir(), "dev-anywhere-preview-spa-"));
    cleanup.push(() => rm(singleIndex, { recursive: true, force: true }));
    await writeFile(join(singleIndex, "index.html"), "spa-index");
    const canonicalSingleIndex = await realpath(singleIndex);
    const spa = await startPreviewGateway({
      source: { kind: "static", rootPath: canonicalSingleIndex, entryPath: "index.html" },
    });
    cleanup.push(() => spa.close());
    const navigation = await requestGateway(spa, "/projects/42", {
      headers: { Accept: "text/html" },
    });
    expect(navigation.status).toBe(200);
    expect(navigation.body.toString()).toBe("spa-index");
    expect(
      (await requestGateway(spa, "/api/missing", { headers: { Accept: "text/html" } })).status,
    ).toBe(404);
    expect(
      (await requestGateway(spa, "/missing.js", { headers: { Accept: "text/html" } })).status,
    ).toBe(404);

    const multiPage = await mkdtemp(join(tmpdir(), "dev-anywhere-preview-mpa-"));
    cleanup.push(() => rm(multiPage, { recursive: true, force: true }));
    await writeFile(join(multiPage, "index.html"), "index");
    await writeFile(join(multiPage, "about.html"), "about");
    const canonicalMultiPage = await realpath(multiPage);
    const mpa = await startPreviewGateway({
      source: { kind: "static", rootPath: canonicalMultiPage, entryPath: "index.html" },
    });
    cleanup.push(() => mpa.close());
    expect(
      (await requestGateway(mpa, "/projects/42", { headers: { Accept: "text/html" } })).status,
    ).toBe(404);

    const arbitrary = await mkdtemp(join(tmpdir(), "dev-anywhere-preview-entry-"));
    cleanup.push(() => rm(arbitrary, { recursive: true, force: true }));
    await writeFile(join(arbitrary, "home.html"), "home");
    const canonicalArbitrary = await realpath(arbitrary);
    const arbitraryEntry = await startPreviewGateway({
      source: { kind: "static", rootPath: canonicalArbitrary, entryPath: "home.html" },
    });
    cleanup.push(() => arbitraryEntry.close());
    expect(
      (await requestGateway(arbitraryEntry, "/projects/42", { headers: { Accept: "text/html" } }))
        .status,
    ).toBe(404);
  });

  it.skipIf(process.platform === "win32")(
    "does not inspect or serve visible symlinks whose canonical target is hidden",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "dev-anywhere-preview-links-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      await writeFile(join(root, "index.html"), "index");
      await writeFile(join(root, ".secret.html"), "secret");
      await symlink(join(root, ".secret.html"), join(root, "public.html"));
      await mkdir(join(root, ".private"));
      await writeFile(join(root, ".private", "inside.html"), "inside");
      await symlink(join(root, ".private"), join(root, "visible"), "dir");
      await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
      await writeFile(join(root, "node_modules", "fixture", "index.html"), "dependency");

      await expect(inspectStaticPreviewPath(join(root, ".secret.html"))).rejects.toThrow(
        /隐藏文件/,
      );
      await expect(inspectStaticPreviewPath(join(root, ".private"))).rejects.toThrow(/隐藏目录/);
      await expect(inspectStaticPreviewPath(join(root, ".private", "inside.html"))).rejects.toThrow(
        /隐藏目录/,
      );
      await expect(inspectStaticPreviewPath(join(root, "node_modules", "fixture"))).rejects.toThrow(
        /node_modules/,
      );
      await expect(
        inspectStaticPreviewPath(join(root, "node_modules", "fixture", "index.html")),
      ).rejects.toThrow(/node_modules/);
      const inspection = await inspectStaticPreviewPath(root);
      expect(inspection.htmlEntries).toEqual(["index.html"]);

      const gateway = await startPreviewGateway({
        source: { kind: "static", rootPath: inspection.rootPath, entryPath: "index.html" },
      });
      cleanup.push(() => gateway.close());
      expect((await requestGateway(gateway, "/public.html")).status).toBe(404);
      expect((await requestGateway(gateway, "/visible/inside.html")).status).toBe(404);
    },
  );
});

describe("local web preview gateway", () => {
  it("connects numerically while preserving local Host/Origin and rewrites loopback redirects", async () => {
    const observed: Array<{ url?: string; host?: string; origin?: string }> = [];
    let upstreamPort = 0;
    const upstream = createServer((request, response) => {
      observed.push({
        url: request.url,
        host: request.headers.host,
        origin: request.headers.origin,
      });
      response.statusCode = 302;
      response.setHeader(
        "Location",
        request.url?.startsWith("/absolute")
          ? `http://127.0.0.1:${upstreamPort}/next?from=absolute`
          : `//localhost:${upstreamPort}/next?from=relative`,
      );
      response.end();
    });
    upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));

    const gateway = await startPreviewGateway({
      source: {
        kind: "local",
        url: `http://localhost:${upstreamPort}/initial?tab=one#details`,
      },
      localHost: "127.0.0.1",
    });
    cleanup.push(() => gateway.close());

    const headers = {
      Host: "quiet-river-42.trycloudflare.com",
      Origin: "https://quiet-river-42.trycloudflare.com",
    };
    const relative = await requestGateway(gateway, "/redirect?value=1", { headers });
    const absolute = await requestGateway(gateway, "/absolute", { headers });

    expect(relative.headers.location).toBe(
      "https://quiet-river-42.trycloudflare.com/next?from=relative",
    );
    expect(absolute.headers.location).toBe(
      "https://quiet-river-42.trycloudflare.com/next?from=absolute",
    );
    expect(observed).toEqual([
      {
        url: "/redirect?value=1",
        host: `localhost:${upstreamPort}`,
        origin: `http://localhost:${upstreamPort}`,
      },
      {
        url: "/absolute",
        host: `localhost:${upstreamPort}`,
        origin: `http://localhost:${upstreamPort}`,
      },
    ]);
    expect(observed.some((request) => request.url?.includes("#"))).toBe(false);
  });

  it("proxies WebSocket upgrades for HMR and rewrites their Host/Origin", async () => {
    const upstream = createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    let observedHost: string | undefined;
    let observedOrigin: string | undefined;
    upstream.on("upgrade", (request, socket, head) => {
      observedHost = request.headers.host;
      observedOrigin = request.headers.origin;
      upstreamWs.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("message", (message) => webSocket.send(message));
      });
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(async () => {
      upstreamWs.close();
      await closeServer(upstream);
    });

    const gateway = await startPreviewGateway({
      source: { kind: "local", url: `http://localhost:${upstreamPort}` },
      localHost: "127.0.0.1",
    });
    cleanup.push(() => gateway.close());

    const wsUrl = gateway.originUrl.replace(/^http:/, "ws:") + "/hmr";
    const client = new WebSocket(wsUrl, {
      origin: "https://quiet-river-42.trycloudflare.com",
      headers: { Host: "quiet-river-42.trycloudflare.com" },
    });
    cleanup.push(async () => client.terminate());
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    client.send("hmr-ping");
    await expect(
      new Promise<string>((resolve, reject) => {
        client.once("message", (message) => resolve(message.toString()));
        client.once("error", reject);
      }),
    ).resolves.toBe("hmr-ping");
    expect(observedHost).toBe(`localhost:${upstreamPort}`);
    expect(observedOrigin).toBe(`http://localhost:${upstreamPort}`);
  });

  it("tears down a streaming upstream when the external HTTP client disconnects", async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: first\n\n");
      response.once("close", upstreamClosed);
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => closeServer(upstream));
    const gateway = await startPreviewGateway({
      source: { kind: "local", url: `http://localhost:${upstreamPort}` },
      localHost: "127.0.0.1",
    });
    cleanup.push(() => gateway.close());

    const url = new URL(gateway.originUrl);
    const clientRequest = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: "/events",
    });
    clientRequest.on("response", (response) => {
      response.once("data", () => clientRequest.destroy());
    });
    clientRequest.end();

    await expect(
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("upstream stream remained open")), 1_000);
        void closed.then(() => {
          clearTimeout(timer);
          resolve();
        }, reject);
      }),
    ).resolves.toBeUndefined();
  });
});
