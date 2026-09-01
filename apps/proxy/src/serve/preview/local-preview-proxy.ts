import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { sendPreviewError, setPreviewResponseHeaders } from "./preview-response-headers.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function upstreamHostHeader(host: "127.0.0.1" | "::1", port: number): string {
  return `${host === "::1" ? "[::1]" : host}:${port}`;
}

function requestPath(request: IncomingMessage): string | null {
  const path = request.url ?? "/";
  return path.startsWith("/") && !path.includes("\0") && !path.includes("\\") ? path : null;
}

function forwardRequestHeaders(
  headers: IncomingHttpHeaders,
  upstreamAuthority: string,
): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    forwarded[name] = value;
  }
  if (headers.host) forwarded["x-forwarded-host"] = headers.host;
  forwarded["x-forwarded-proto"] = "https";
  forwarded["x-forwarded-port"] = "443";
  forwarded.host = upstreamAuthority;
  if (headers.origin) forwarded.origin = `http://${upstreamAuthority}`;
  return forwarded;
}

function rewriteLoopbackLocation(
  value: string,
  request: IncomingMessage,
  upstreamPort: number,
): string {
  let location: URL;
  try {
    if (!/^(?:http:)?\/\//i.test(value)) return value;
    location = new URL(value, "http://preview.invalid");
  } catch {
    return value;
  }
  const hostname = location.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  const port = location.port ? Number(location.port) : 80;
  if (!loopback || location.protocol !== "http:" || port !== upstreamPort) return value;
  if (!request.headers.host) return value;
  try {
    return new URL(
      `${location.pathname}${location.search}${location.hash}`,
      `https://${request.headers.host}`,
    ).toString();
  } catch {
    return value;
  }
}

function copyResponseHeaders(
  source: IncomingMessage,
  request: IncomingMessage,
  response: ServerResponse,
  upstreamPort: number,
): void {
  for (const [name, value] of Object.entries(source.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    try {
      response.setHeader(
        name,
        name.toLowerCase() === "location" && typeof value === "string"
          ? rewriteLoopbackLocation(value, request, upstreamPort)
          : value,
      );
    } catch {
      // An invalid optional upstream header must not tear down the whole preview response.
    }
  }
  setPreviewResponseHeaders(response);
}

export class LocalPreviewProxy {
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly host: "127.0.0.1" | "::1",
    private readonly port: number,
    private readonly upstreamAuthority = upstreamHostHeader(host, port),
  ) {}

  handle(request: IncomingMessage, response: ServerResponse): void {
    const path = requestPath(request);
    if (path === null) {
      sendPreviewError(response, 400, "请求地址无效");
      return;
    }

    const upstream = httpRequest(
      {
        hostname: this.host,
        port: this.port,
        method: request.method,
        path,
        headers: forwardRequestHeaders(request.headers, this.upstreamAuthority),
      },
      (upstreamResponse) => {
        response.statusCode = upstreamResponse.statusCode ?? 502;
        if (upstreamResponse.statusMessage) response.statusMessage = upstreamResponse.statusMessage;
        copyResponseHeaders(upstreamResponse, request, response, this.port);
        upstreamResponse.once("error", () => response.destroy());
        upstreamResponse.pipe(response);
      },
    );

    upstream.once("socket", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    upstream.once("error", () => {
      if (response.headersSent) response.destroy();
      else sendPreviewError(response, 502, "本地网页暂时无法访问");
    });
    request.once("aborted", () => upstream.destroy());
    request.once("error", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  }

  handleUpgrade(request: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const path = requestPath(request);
    if (path === null) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }

    const upstreamSocket = connect({ host: this.host, port: this.port });
    this.sockets.add(upstreamSocket);
    upstreamSocket.once("close", () => this.sockets.delete(upstreamSocket));
    upstreamSocket.once("connect", () => {
      const headers = forwardRequestHeaders(request.headers, this.upstreamAuthority);
      headers.connection = "Upgrade";
      headers.upgrade = request.headers.upgrade ?? "websocket";
      const lines = [`${request.method ?? "GET"} ${path} HTTP/${request.httpVersion}`];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    upstreamSocket.once("error", () => {
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    });
    clientSocket.once("error", () => upstreamSocket.destroy());
    clientSocket.once("close", () => upstreamSocket.destroy());
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }
}
