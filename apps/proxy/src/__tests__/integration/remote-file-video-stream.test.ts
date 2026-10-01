import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, type RelayServer } from "@dev-anywhere/relay/server";
import { createLogger } from "@dev-anywhere/shared/logger";
import {
  decodeFileStreamFrame,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayControlSchema,
  serializeControl,
  type RelayControlMessage,
} from "@dev-anywhere/shared";
import { RemoteFileStreamManager } from "#src/serve/remote-file-stream.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";
import type { SessionManager } from "#src/serve/session-manager.js";
import { createSessionManagerFake } from "../unit/test-fakes.js";

function waitForControl(ws: WebSocket, type: RelayControlMessage["type"]) {
  return new Promise<RelayControlMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 3000);
    function onMessage(data: { toString(): string }, binary: boolean) {
      if (binary) return;
      const parsed = RelayControlSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || parsed.data.type !== type) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(parsed.data);
    }
    ws.on("message", onMessage);
  });
}

describe("remote video HTTP streaming through the relay and proxy", () => {
  let dir: string;
  let origin: string;
  let relay: RelayServer;
  let proxy: WebSocket;
  let client: WebSocket;
  let manager: RemoteFileStreamManager;
  let sessionManager: SessionManager;
  let legacyProxy: boolean;
  let holdStreams: boolean;
  let bytesRead: number;
  let proxyControls: RelayControlMessage[];
  const contents = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "dev-anywhere-video-stream-"));
    writeFileSync(join(dir, "video.mp4"), contents);
    legacyProxy = false;
    holdStreams = false;
    bytesRead = 0;
    proxyControls = [];
    relay = createRelayServer({
      port: 0,
      heartbeatInterval: 60_000,
      logger: createLogger({ name: "video-stream-test", silent: true }),
      dataDir: join(dir, "data"),
    });
    await new Promise<void>((resolve) => relay.httpServer.listen(0, "127.0.0.1", resolve));
    const address = relay.httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing relay port");
    origin = `http://127.0.0.1:${address.port}`;
    proxy = new WebSocket(`ws://127.0.0.1:${address.port}/proxy`);
    await once(proxy, "open");
    sessionManager = createSessionManagerFake([
      {
        id: "s1",
        kind: "agent",
        mode: "json",
        provider: "claude",
        state: "idle",
        createdAt: 1,
        updatedAt: 1,
        cwd: dir,
        pid: 1,
      },
    ]);
    manager = new RemoteFileStreamManager({
      relayConnection: {
        sendRaw(raw: string) {
          if (legacyProxy) {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            delete msg.statusCode;
            delete msg.contentRange;
            delete msg.flowControl;
            raw = JSON.stringify(msg);
          }
          proxy.send(raw);
        },
        sendBinary(data: Uint8Array) {
          bytesRead += decodeFileStreamFrame(data)?.data.byteLength ?? 0;
          proxy.send(data);
        },
      } as unknown as RelayConnection,
      sessionManager,
    });
    proxy.on("message", (data, binary) => {
      if (binary) return;
      const parsed = RelayControlSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) return;
      const msg = parsed.data;
      proxyControls.push(msg);
      if (msg.type === "remote_file_metadata_request") manager.metadata(msg);
      if (msg.type === "remote_file_stream_request" && !holdStreams) {
        const request = { ...msg };
        if (legacyProxy) {
          delete request.range;
          delete request.head;
          delete request.flowControl;
        }
        manager.start(request);
      }
      if (msg.type === "remote_file_stream_cancel") manager.cancel(msg);
      if (msg.type === "remote_file_stream_ack") manager.acknowledge(msg);
    });
    let response = waitForControl(proxy, "proxy_register_response");
    proxy.send(
      serializeControl({
        type: "proxy_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        proxyId: "video-proxy",
        proxyVersion: "0.9.17",
      }),
    );
    await response;
    proxy.send(
      JSON.stringify({
        type: "session_sync",
        sessions: [
          { id: "s1", kind: "agent", mode: "json", provider: "claude", cwd: dir, state: "idle" },
        ],
      }),
    );
    await vi.waitFor(() => expect(relay.registry.getProxyForSession("s1")).toBe("video-proxy"));
    client = new WebSocket(`ws://127.0.0.1:${address.port}/client`);
    await once(client, "open");
    response = waitForControl(client, "client_register_response");
    client.send(
      serializeControl({
        type: "client_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        clientId: "video-client",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await response;
    response = waitForControl(client, "proxy_select_response");
    client.send(serializeControl({ type: "proxy_select", proxyId: "video-proxy" }));
    await response;
  });

  afterEach(async () => {
    manager?.cancelAll();
    client?.terminate();
    proxy?.terminate();
    await relay?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function issueUrl(path = "video.mp4", disposition: "inline" | "download" = "inline") {
    const response = waitForControl(client, "remote_file_url_response");
    client.send(
      serializeControl({
        type: "remote_file_url_request",
        requestId: "video-url",
        sessionId: "s1",
        path,
        disposition,
      }),
    );
    const msg = await response;
    if (msg.type !== "remote_file_url_response" || !msg.success || !msg.url) {
      throw new Error(`Failed to issue URL: ${JSON.stringify(msg)}`);
    }
    return `${origin}${msg.url}`;
  }

  it("reuses one inline URL for initial playback, forward and backward seeks", async () => {
    const url = await issueUrl();
    for (const [range, start, end] of [
      ["bytes=0-1", 0, 1],
      ["bytes=24-", 24, 35],
      ["bytes=4-10", 4, 10],
      ["bytes=-4", 32, 35],
    ] as const) {
      const res = await fetch(url, {
        headers: { Range: range },
        signal: AbortSignal.timeout(3000),
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-type")).toBe("video/mp4");
      expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/${contents.length}`);
      expect(res.headers.get("content-length")).toBe(String(end - start + 1));
      expect(Buffer.from(await res.arrayBuffer())).toEqual(contents.subarray(start, end + 1));
    }
    expect(bytesRead).toBe(25);
  });

  it("uses the current file size when a previously issued URL is opened", async () => {
    const url = await issueUrl();
    writeFileSync(join(dir, "video.mp4"), "changed");
    const res = await fetch(url, { headers: { Range: "bytes=3-999" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 3-6/7");
    expect(await res.text()).toBe("nged");
  });

  it("keeps a relative file URL bound to its original file after the session changes cwd", async () => {
    const url = await issueUrl();
    const anotherDir = join(dir, "another");
    mkdirSync(anotherDir);
    writeFileSync(join(anotherDir, "video.mp4"), "wrong file");
    sessionManager.getSession("s1")!.cwd = anotherDir;
    const res = await fetch(url, { headers: { Range: "bytes=24-" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 24-35/36");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(contents.subarray(24));
  });

  it.each([
    "bytes=36-",
    "bytes=5-3",
    "bytes=-0",
    "bytes=1-2,4-5",
    "bytes=NaN-",
    "bytes=0-9007199254740992",
    "bytes=-",
    "items=1-2",
  ])("rejects invalid or unsatisfiable Range %s without reading data", async (range) => {
    const res = await fetch(await issueUrl(), { headers: { Range: range } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${contents.length}`);
    expect(res.headers.get("content-length")).toBe("0");
    expect(await res.text()).toBe("");
    expect(bytesRead).toBe(0);
  });

  it("answers HEAD without opening a file stream and ignores Range on HEAD", async () => {
    const res = await fetch(await issueUrl(), { method: "HEAD", headers: { Range: "bytes=0-1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(contents.length));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-range")).toBeNull();
    expect(await res.text()).toBe("");
    expect(bytesRead).toBe(0);
    expect(proxyControls.find((msg) => msg.type === "remote_file_stream_request")).toMatchObject({
      head: true,
    });
  });

  it.each([
    ["webm", "video/webm"],
    ["m4v", "video/mp4"],
    ["mov", "video/quicktime"],
    ["ogv", "video/ogg"],
  ])("returns the correct MIME for %s files", async (extension, mimeType) => {
    writeFileSync(join(dir, `video.${extension}`), contents);
    const res = await fetch(await issueUrl(`video.${extension}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(mimeType);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(contents);
  });

  it("keeps downloads as attachments and streams beyond the credit window", async () => {
    const largeContents = Buffer.alloc(3 * 1024 * 1024 + 17, 42);
    writeFileSync(join(dir, "video.mp4"), largeContents);
    const res = await fetch(await issueUrl("video.mp4", "download"), {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(Buffer.from(await res.arrayBuffer()).equals(largeContents)).toBe(true);
    expect(proxyControls.some((msg) => msg.type === "remote_file_stream_ack")).toBe(true);
  });

  it("returns an empty file and rejects ranges on it without waiting for a chunk", async () => {
    writeFileSync(join(dir, "empty.mp4"), "");
    const url = await issueUrl("empty.mp4");
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect(await res.text()).toBe("");
    const ranged = await fetch(url, { headers: { Range: "bytes=0-" } });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
    expect(await ranged.text()).toBe("");
    expect(bytesRead).toBe(0);
  });

  it("keeps a legacy proxy's ignored Range as 200 and sends no chunk credits", async () => {
    legacyProxy = true;
    const res = await fetch(await issueUrl(), { headers: { Range: "bytes=1-3" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("accept-ranges")).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(contents);
    expect(proxyControls.some((msg) => msg.type === "remote_file_stream_ack")).toBe(false);
  });

  it("cancels a legacy proxy after HEAD headers instead of waiting for its full file", async () => {
    legacyProxy = true;
    truncateSync(join(dir, "video.mp4"), 64 * 1024 * 1024);
    const res = await fetch(await issueUrl(), {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(64 * 1024 * 1024));
    expect(await res.text()).toBe("");
    await vi.waitFor(() =>
      expect(proxyControls.some((msg) => msg.type === "remote_file_stream_cancel")).toBe(true),
    );
    expect(bytesRead).toBeLessThan(64 * 1024 * 1024);
  });

  it("cancels disk reads when the HTTP consumer disconnects", async () => {
    truncateSync(join(dir, "video.mp4"), 64 * 1024 * 1024);
    const url = await issueUrl();
    await new Promise<void>((resolve, reject) => {
      const request = get(url, (res) => {
        res.pause();
        res.destroy();
        resolve();
      });
      request.on("error", reject);
    });
    await vi.waitFor(() =>
      expect(proxyControls.some((msg) => msg.type === "remote_file_stream_cancel")).toBe(true),
    );
    expect(bytesRead).toBeLessThan(64 * 1024 * 1024);
  });

  it.each([false, true])(
    "ends pending HTTP reads when the proxy disconnects (graceful=%s)",
    async (graceful) => {
      const url = await issueUrl();
      holdStreams = true;
      const requested = waitForControl(proxy, "remote_file_stream_request");
      const response = fetch(url, { signal: AbortSignal.timeout(3000) });
      await requested;
      if (graceful)
        proxy.send(serializeControl({ type: "proxy_disconnect", proxyId: "video-proxy" }));
      else proxy.terminate();
      const res = await response;
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "开发机连接已断开" });
    },
  );

  it("ends an existing HTTP body when a new connection replaces the same proxy", async () => {
    const url = await issueUrl();
    holdStreams = true;
    const requested = waitForControl(proxy, "remote_file_stream_request");
    const response = fetch(url, { signal: AbortSignal.timeout(3000) });
    const request = await requested;
    if (request.type !== "remote_file_stream_request") throw new Error("Missing stream request");
    proxy.send(
      serializeControl({
        type: "remote_file_stream_response",
        streamId: request.streamId,
        sessionId: "s1",
        success: true,
        statusCode: 200,
        mimeType: "video/mp4",
        size: contents.length,
      }),
    );
    const res = await response;
    expect(res.status).toBe(200);
    const bodyFailure = expect(res.text()).rejects.toMatchObject({ name: "TypeError" });
    const replacement = new WebSocket(`${origin.replace("http:", "ws:")}/proxy`);
    try {
      await once(replacement, "open");
      const registered = waitForControl(replacement, "proxy_register_response");
      replacement.send(
        serializeControl({
          type: "proxy_register",
          protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          proxyId: "video-proxy",
          proxyVersion: "0.9.17",
        }),
      );
      expect(await registered).toMatchObject({ status: "reconnected" });
      await bodyFailure;
    } finally {
      replacement.terminate();
    }
  });
});
