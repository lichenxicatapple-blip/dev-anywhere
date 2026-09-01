import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  PREVIEW_HEALTH_HEADER,
  PREVIEW_HEALTH_MARKER,
  PREVIEW_HEALTH_PATH,
} from "../../common/quick-tunnel-readiness.js";
import { LocalPreviewProxy } from "./local-preview-proxy.js";
import { StaticPreviewHandler } from "./static-preview-handler.js";
import { inspectStaticPreviewPath } from "./static-preview.js";
import type { PreviewSource } from "./types.js";

export interface PreviewGateway {
  originUrl: string;
  deactivate(): void;
  close(): Promise<void>;
}

interface PreviewGatewayOptions {
  source: PreviewSource;
  localHost?: "127.0.0.1" | "::1";
  createServer?: typeof createServer;
}

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法确定网页预览 Gateway 端口"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

export async function startPreviewGateway(options: PreviewGatewayOptions): Promise<PreviewGateway> {
  const sockets = new Set<Socket>();
  let active = true;
  const staticInspection =
    options.source.kind === "static"
      ? await inspectStaticPreviewPath(options.source.rootPath)
      : null;
  const documentFallback =
    staticInspection?.htmlEntries.length === 1 &&
    staticInspection.htmlEntries[0] === "index.html" &&
    options.source.kind === "static" &&
    options.source.entryPath === "index.html";
  const staticHandler =
    options.source.kind === "static"
      ? new StaticPreviewHandler(
          options.source.rootPath,
          options.source.entryPath,
          documentFallback,
        )
      : null;
  const localUrl = options.source.kind === "local" ? new URL(options.source.url) : null;
  const localProxy =
    localUrl && options.localHost
      ? new LocalPreviewProxy(
          options.localHost,
          localUrl.port ? Number(localUrl.port) : 80,
          localUrl.host,
        )
      : null;

  if (options.source.kind === "local" && !localProxy) {
    throw new Error("本地网页 Gateway 缺少已验证的 loopback 地址");
  }

  const server = (options.createServer ?? createServer)(
    (request: IncomingMessage, response: ServerResponse) => {
      if (!active) {
        response.statusCode = 410;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Connection", "close");
        response.end();
        return;
      }
      if (
        request.url === PREVIEW_HEALTH_PATH &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        response.statusCode = 204;
        response.setHeader(PREVIEW_HEALTH_HEADER, PREVIEW_HEALTH_MARKER);
        response.setHeader("Cache-Control", "no-store");
        response.end();
        return;
      }
      if (staticHandler) {
        void staticHandler.handle(request, response);
      } else {
        localProxy!.handle(request, response);
      }
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (!active) {
      socket.end("HTTP/1.1 410 Gone\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!localProxy) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    localProxy.handleUpgrade(request, socket, head);
  });

  const port = await listenLoopback(server);
  let closePromise: Promise<void> | null = null;
  const deactivate = () => {
    if (!active) return;
    active = false;
    localProxy?.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.closeAllConnections?.();
  };
  return {
    originUrl: `http://127.0.0.1:${port}`,
    deactivate,
    close() {
      deactivate();
      if (!closePromise) {
        closePromise = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }).catch((error: unknown) => {
          closePromise = null;
          throw error;
        });
      }
      return closePromise;
    },
  };
}
