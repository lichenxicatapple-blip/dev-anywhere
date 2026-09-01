import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket, type RawData } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
import {
  decodeFileStreamFrame,
  encodeFileStreamFrame,
  serializeControl,
} from "@dev-anywhere/shared";
import {
  collectMessages,
  waitForOpen,
  waitForMessage,
  waitForMessageType,
  getPort,
} from "../helpers.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logger = createLogger({ name: "test", silent: true });
const MIN_REMOTE_FILE_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Relay Server Integration", () => {
  let relay: RelayServer;
  let port: number;
  let tempRoot: string;
  const connections: WebSocket[] = [];

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "dev-anywhere-relay-"));
    const packagedFontDir = join(tempRoot, "packaged-fonts");
    mkdirSync(join(packagedFontDir, "sarasa-fixed-sc"), { recursive: true });
    writeFileSync(join(packagedFontDir, "sarasa-fixed-sc", "result.css"), "/* packaged font */");
    // Match the packaged Docker layout. The Web root itself lives below an
    // `assets` ancestor, while only its child `assets/` directory is hashed.
    const webAssetDir = join(tempRoot, "app", "assets", "web");
    mkdirSync(join(webAssetDir, "assets"), { recursive: true });
    writeFileSync(join(webAssetDir, "index.html"), "<!doctype html><main>DEV Anywhere</main>");
    writeFileSync(join(webAssetDir, "assets", "app-abc123.js"), "console.log('app');");
    writeFileSync(join(webAssetDir, "sw.js"), "self.addEventListener('fetch', () => {});");
    relay = createRelayServer({
      port: 0,
      heartbeatInterval: 60000,
      logger,
      dataDir: join(tempRoot, "data"),
      fontAssetDir: packagedFontDir,
      webAssetDir,
    });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    port = getPort(relay);
  });

  afterEach(async () => {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    connections.length = 0;
    await relay.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function connectProxy(): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy`);
    connections.push(ws);
    return ws;
  }

  function connectClient(): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
    connections.push(ws);
    return ws;
  }

  it("proxy connects and registers", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);

    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "test-proxy" }));
    await waitForCondition(
      () => relay.registry.listProxies().includes("test-proxy"),
      "proxy registration timed out",
    );

    expect(relay.registry.listProxies()).toContain("test-proxy");
  });

  it("client sends proxy_list_request and receives response", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForCondition(() => relay.registry.listProxies().includes("p1"), "proxy not listed");

    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_list_request" }));
    const response = JSON.parse(await msgPromise);

    expect(response.type).toBe("proxy_list_response");
    expect(response.proxies).toEqual([{ proxyId: "p1", online: true, sessions: [] }]);
  });

  it("removes an offline proxy, ACKs its formerly bound client, then broadcasts removal and list", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "retired-proxy" }));
    await waitForMessageType(proxy, "proxy_register_response");

    const requester = connectClient();
    const observer = connectClient();
    await Promise.all([waitForOpen(requester), waitForOpen(observer)]);
    requester.send(
      JSON.stringify({
        type: "client_register",
        clientId: "remove-requester",
        browserName: "Safari",
        osName: "iOS",
        deviceKind: "phone",
      }),
    );
    observer.send(
      JSON.stringify({
        type: "client_register",
        clientId: "remove-observer",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await Promise.all([
      waitForMessageType(requester, "client_register_response"),
      waitForMessageType(observer, "client_register_response"),
    ]);
    requester.send(JSON.stringify({ type: "proxy_select", proxyId: "retired-proxy" }));
    await waitForMessageType(requester, "proxy_select_response");

    const requesterOffline = waitForMessageType(requester, "proxy_offline");
    const requesterOfflineList = waitForMessageType(requester, "proxy_list_response");
    const observerOfflineList = waitForMessageType(observer, "proxy_list_response");
    proxy.close();
    await Promise.all([requesterOffline, requesterOfflineList, observerOfflineList]);
    await waitForCondition(
      () => relay.registry.getProxyConnectionState("retired-proxy") === "offline",
      "proxy did not transition offline",
    );

    const requesterMessagesPromise = collectMessages(requester, 3);
    const observerMessagesPromise = collectMessages(observer, 2);
    requester.send(
      JSON.stringify({
        type: "proxy_remove",
        requestId: "remove-retired-proxy",
        proxyId: "retired-proxy",
      }),
    );

    const requesterMessages = (await requesterMessagesPromise).map((raw) => JSON.parse(raw));
    const observerMessages = (await observerMessagesPromise).map((raw) => JSON.parse(raw));
    expect(requesterMessages.map((message) => message.type)).toEqual([
      "proxy_remove_response",
      "proxy_removed",
      "proxy_list_response",
    ]);
    expect(requesterMessages[0]).toEqual({
      type: "proxy_remove_response",
      requestId: "remove-retired-proxy",
      proxyId: "retired-proxy",
      success: true,
    });
    expect(requesterMessages[1]).toEqual({
      type: "proxy_removed",
      proxyId: "retired-proxy",
    });
    expect(requesterMessages[2]).toMatchObject({ type: "proxy_list_response", proxies: [] });
    expect(observerMessages).toEqual([
      { type: "proxy_removed", proxyId: "retired-proxy" },
      { type: "proxy_list_response", proxies: [] },
    ]);
    expect(relay.registry.hasProxy("retired-proxy")).toBe(false);
    expect(relay.registry.getClientBinding("remove-requester")).toBeUndefined();
    expect(requester.readyState).toBe(WebSocket.OPEN);

    // A new machine may later reuse the same configured ID. The old socket must not regain
    // routing implicitly after the registry entry is recreated.
    const replacement = connectProxy();
    await waitForOpen(replacement);
    replacement.send(JSON.stringify({ type: "proxy_register", proxyId: "retired-proxy" }));
    await waitForMessageType(replacement, "proxy_register_response");
    const notBoundPromise = waitForMessageType(requester, "relay_error");
    requester.send(
      JSON.stringify({
        seq: 1,
        sessionId: "old-session",
        timestamp: Date.now(),
        source: "client",
        version: "1.0",
        type: "user_input",
        payload: { text: "must not route" },
      }),
    );
    expect(JSON.parse(await notBoundPromise)).toMatchObject({ code: "NOT_BOUND" });
  });

  it("rejects online and unknown proxy removal with explicit errors", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "online-proxy" }));
    await waitForMessageType(proxy, "proxy_register_response");

    const unregisteredClient = connectClient();
    await waitForOpen(unregisteredClient);
    const notRegisteredPromise = waitForMessageType(unregisteredClient, "relay_error");
    unregisteredClient.send(
      JSON.stringify({
        type: "proxy_remove",
        requestId: "remove-before-register",
        proxyId: "online-proxy",
      }),
    );
    expect(JSON.parse(await notRegisteredPromise)).toMatchObject({
      requestId: "remove-before-register",
      code: "NOT_REGISTERED",
    });
    expect(relay.registry.isProxyOnline("online-proxy")).toBe(true);

    const client = connectClient();
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: "client_register",
        clientId: "remove-errors-client",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await waitForMessageType(client, "client_register_response");

    const onlineResponsePromise = waitForMessageType(client, "proxy_remove_response");
    client.send(
      JSON.stringify({
        type: "proxy_remove",
        requestId: "remove-online",
        proxyId: "online-proxy",
      }),
    );
    expect(JSON.parse(await onlineResponsePromise)).toMatchObject({
      requestId: "remove-online",
      proxyId: "online-proxy",
      success: false,
      errorCode: "PROXY_ONLINE",
      error: expect.stringContaining("仍在线"),
    });
    expect(relay.registry.isProxyOnline("online-proxy")).toBe(true);

    const unknownResponsePromise = waitForMessageType(client, "proxy_remove_response");
    client.send(
      JSON.stringify({
        type: "proxy_remove",
        requestId: "remove-missing",
        proxyId: "missing-proxy",
      }),
    );
    expect(JSON.parse(await unknownResponsePromise)).toMatchObject({
      requestId: "remove-missing",
      proxyId: "missing-proxy",
      success: false,
      errorCode: "PROXY_NOT_FOUND",
      error: expect.stringContaining("不存在"),
    });
    expect(relay.registry.hasProxy("online-proxy")).toBe(true);
  });

  it("revokes remote file tokens and pending metadata when an offline proxy is removed", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "file-proxy" }));
    await waitForMessageType(proxy, "proxy_register_response");
    proxy.send(
      JSON.stringify({
        type: "session_sync",
        sessions: [{ id: "file-session", mode: "pty", provider: "claude", state: "idle" }],
      }),
    );
    await waitForCondition(
      () => relay.registry.getProxyForSession("file-session") === "file-proxy",
      "file session not indexed",
    );

    const client = connectClient();
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: "client_register",
        clientId: "file-client",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await waitForMessageType(client, "client_register_response");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "file-proxy" }));
    await waitForMessageType(client, "proxy_select_response");

    const metadataRequestPromise = waitForMessageType(proxy, "remote_file_metadata_request");
    client.send(
      JSON.stringify({
        type: "remote_file_url_request",
        requestId: "issued-download",
        sessionId: "file-session",
        path: "build/result.txt",
        disposition: "download",
      }),
    );
    const metadataRequest = JSON.parse(await metadataRequestPromise) as { requestId: string };
    const issuedDownloadPromise = waitForMessageType(client, "remote_file_url_response");
    proxy.send(
      serializeControl({
        type: "remote_file_metadata_response",
        requestId: metadataRequest.requestId,
        sessionId: "file-session",
        success: true,
        path: "build/result.txt",
        mimeType: "text/plain",
        size: 6,
        fileName: "result.txt",
      }),
    );
    const issuedDownload = JSON.parse(await issuedDownloadPromise) as { url: string };

    const issuedUploadPromise = waitForMessageType(client, "remote_file_upload_url_response");
    client.send(
      JSON.stringify({
        type: "remote_file_upload_url_request",
        requestId: "issued-upload",
        sessionId: "file-session",
        kind: "file",
        fileName: "upload.txt",
        mimeType: "text/plain",
        size: 6,
      }),
    );
    const issuedUpload = JSON.parse(await issuedUploadPromise) as { uploadUrl: string };

    const pendingMetadataRequestPromise = waitForMessageType(proxy, "remote_file_metadata_request");
    client.send(
      JSON.stringify({
        type: "remote_file_url_request",
        requestId: "pending-download",
        sessionId: "file-session",
        path: "build/pending.txt",
        disposition: "inline",
      }),
    );
    await pendingMetadataRequestPromise;

    const offlinePromise = waitForMessageType(client, "proxy_offline");
    const offlineListPromise = waitForMessageType(client, "proxy_list_response");
    proxy.close();
    await Promise.all([offlinePromise, offlineListPromise]);
    await waitForCondition(
      () => relay.registry.getProxyConnectionState("file-proxy") === "offline",
      "file proxy did not transition offline",
    );

    const removeResponsePromise = waitForMessageType(client, "proxy_remove_response");
    const removedPromise = waitForMessageType(client, "proxy_removed");
    const updatedListPromise = waitForMessageType(client, "proxy_list_response");
    const pendingFailurePromise = waitForMessageType(client, "remote_file_url_response");
    client.send(
      JSON.stringify({
        type: "proxy_remove",
        requestId: "remove-file-proxy",
        proxyId: "file-proxy",
      }),
    );
    expect(JSON.parse(await removeResponsePromise)).toMatchObject({ success: true });
    await Promise.all([removedPromise, updatedListPromise]);
    expect(JSON.parse(await pendingFailurePromise)).toMatchObject({
      type: "remote_file_url_response",
      requestId: "pending-download",
      success: false,
      errorCode: "PROXY_NOT_FOUND",
    });

    const downloadResponse = await fetch(`http://127.0.0.1:${port}${issuedDownload.url}`);
    expect(downloadResponse.status).toBe(404);
    expect(await downloadResponse.json()).toEqual({ error: "remote_file_url_expired" });

    const uploadResponse = await fetch(`http://127.0.0.1:${port}${issuedUpload.uploadUrl}`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "denied",
    });
    expect(uploadResponse.status).toBe(404);
    expect(await uploadResponse.json()).toEqual({ error: "remote_file_upload_url_expired" });
  });

  it("client selects proxy and messages route bidirectionally", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForCondition(() => relay.registry.listProxies().includes("p1"), "proxy not listed");

    const client = connectClient();
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: "client_register",
        clientId: "client-routing",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await waitForMessageType(client, "client_register_response");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    // 消费 proxy_select_response ACK
    const ack = JSON.parse(await waitForMessage(client));
    expect(ack.type).toBe("proxy_select_response");
    expect(ack.success).toBe(true);

    // proxy -> client
    const clientMsgPromise = waitForMessage(client);
    const envelope = {
      seq: 1,
      sessionId: "s1",
      timestamp: Date.now(),
      source: "proxy",
      version: "1.0",
      type: "assistant_message",
      payload: {
        turnId: "turn-1",
        revision: 1,
        text: "hello from proxy",
        status: "completed",
      },
    };
    proxy.send(JSON.stringify(envelope));
    const received = JSON.parse(await clientMsgPromise);
    expect(received.type).toBe("assistant_message");
    expect(received.payload.text).toBe("hello from proxy");

    // client -> proxy
    const proxyMsgPromise = waitForMessage(proxy);
    const clientEnvelope = {
      seq: 2,
      sessionId: "s1",
      timestamp: Date.now(),
      source: "client",
      version: "1.0",
      type: "user_input",
      payload: { text: "hello from client" },
    };
    client.send(JSON.stringify(clientEnvelope));
    const proxyReceived = JSON.parse(await proxyMsgPromise);
    expect(proxyReceived.type).toBe("user_input");
    expect(proxyReceived.payload.text).toBe("hello from client");
  });

  it("streams remote files from proxy binary frames to HTTP responses", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForMessage(proxy);
    proxy.send(
      JSON.stringify({
        type: "session_sync",
        sessions: [{ id: "s1", mode: "pty", provider: "claude", state: "idle" }],
      }),
    );
    await waitForCondition(
      () => relay.registry.getProxyForSession("s1") === "p1",
      "session not indexed",
    );

    const client = connectClient();
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: "client_register",
        clientId: "client-remote-file",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await waitForMessageType(client, "client_register_response");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessageType(client, "proxy_select_response");

    const metadataRequestPromise = waitForMessageType(proxy, "remote_file_metadata_request");
    client.send(
      JSON.stringify({
        type: "remote_file_url_request",
        requestId: "remote-url-1",
        sessionId: "s1",
        path: "build/out.txt",
        disposition: "download",
      }),
    );
    const urlRequestedAt = Date.now();
    const metadataRequest = JSON.parse(await metadataRequestPromise) as {
      requestId: string;
      sessionId: string;
      path: string;
    };
    expect(metadataRequest).toMatchObject({
      sessionId: "s1",
      path: "build/out.txt",
    });

    const urlPromise = waitForMessageType(client, "remote_file_url_response");
    proxy.send(
      serializeControl({
        type: "remote_file_metadata_response",
        requestId: metadataRequest.requestId,
        sessionId: "s1",
        success: true,
        path: "build/out.txt",
        mimeType: "text/plain",
        size: 11,
        fileName: "out.txt",
      }),
    );
    const urlResponse = JSON.parse(await urlPromise) as {
      url: string;
      expiresAt: number;
      success: boolean;
    };
    expect(urlResponse).toMatchObject({
      success: true,
      url: expect.stringMatching(/^\/api\/remote-files\//),
    });
    expect(urlResponse.expiresAt - urlRequestedAt).toBeGreaterThanOrEqual(
      MIN_REMOTE_FILE_TOKEN_TTL_MS,
    );

    const streamRequestPromise = waitForMessageType(proxy, "remote_file_stream_request");
    const fetchPromise = fetch(`http://127.0.0.1:${port}${urlResponse.url}`);
    const streamRequest = JSON.parse(await streamRequestPromise) as {
      streamId: string;
      sessionId: string;
      path: string;
      disposition: string;
    };
    expect(streamRequest).toMatchObject({
      sessionId: "s1",
      path: "build/out.txt",
      disposition: "download",
    });

    const unicodeFileName = "面试三问话术_搜索Fanout_DEVAnywhere_Agent.md";
    proxy.send(
      serializeControl({
        type: "remote_file_stream_response",
        streamId: streamRequest.streamId,
        sessionId: "s1",
        success: true,
        path: "build/out.txt",
        mimeType: "text/plain",
        size: 11,
        fileName: unicodeFileName,
      }),
    );
    proxy.send(
      encodeFileStreamFrame(streamRequest.streamId, 0, new TextEncoder().encode("hello ")),
    );
    proxy.send(encodeFileStreamFrame(streamRequest.streamId, 1, new TextEncoder().encode("world")));
    proxy.send(
      serializeControl({
        type: "remote_file_stream_complete",
        streamId: streamRequest.streamId,
        success: true,
      }),
    );

    const res = await fetchPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const contentDisposition = res.headers.get("content-disposition");
    expect(contentDisposition).toContain("attachment");
    expect(contentDisposition).toContain(`filename*=UTF-8''${encodeURIComponent(unicodeFileName)}`);
    expect(contentDisposition).not.toContain("面试");
    expect(await res.text()).toBe("hello world");
  });

  it("preflights remote file URLs and rejects missing files before issuing a URL", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForMessage(proxy);
    proxy.send(
      JSON.stringify({
        type: "session_sync",
        sessions: [{ id: "s1", mode: "pty", provider: "claude", state: "idle" }],
      }),
    );
    await waitForCondition(
      () => relay.registry.getProxyForSession("s1") === "p1",
      "session not indexed",
    );

    const client = connectClient();
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: "client_register",
        clientId: "client-remote-file-missing",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await waitForMessageType(client, "client_register_response");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessageType(client, "proxy_select_response");

    const metadataRequestPromise = waitForMessageType(proxy, "remote_file_metadata_request");
    client.send(
      JSON.stringify({
        type: "remote_file_url_request",
        requestId: "remote-url-missing",
        sessionId: "s1",
        path: "pa_break_analysis/SKILL.md",
        disposition: "download",
      }),
    );

    const metadataRequest = JSON.parse(await metadataRequestPromise) as {
      requestId: string;
      sessionId: string;
      path: string;
    };
    expect(metadataRequest).toMatchObject({
      sessionId: "s1",
      path: "pa_break_analysis/SKILL.md",
    });

    const urlPromise = waitForMessageType(client, "remote_file_url_response");
    proxy.send(
      serializeControl({
        type: "remote_file_metadata_response",
        requestId: metadataRequest.requestId,
        sessionId: "s1",
        success: false,
        path: "pa_break_analysis/SKILL.md",
        error: "ENOENT: no such file or directory",
        errorCode: "PATH_NOT_FOUND",
      }),
    );
    const urlResponse = JSON.parse(await urlPromise) as {
      success: boolean;
      url?: string;
      error?: string;
      errorCode?: string;
    };

    expect(urlResponse).toMatchObject({
      type: "remote_file_url_response",
      requestId: "remote-url-missing",
      sessionId: "s1",
      success: false,
      errorCode: "PATH_NOT_FOUND",
    });
    expect(urlResponse.url).toBeUndefined();
  });

  it("streams HTTP uploads to proxy binary frames", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForMessage(proxy);
    proxy.send(
      JSON.stringify({
        type: "session_sync",
        sessions: [{ id: "s1", mode: "pty", provider: "claude", state: "idle" }],
      }),
    );
    await waitForCondition(
      () => relay.registry.getProxyForSession("s1") === "p1",
      "session not indexed",
    );

    const client = connectClient();
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: "client_register",
        clientId: "client-upload",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await waitForMessageType(client, "client_register_response");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessageType(client, "proxy_select_response");

    const urlPromise = waitForMessageType(client, "remote_file_upload_url_response");
    client.send(
      JSON.stringify({
        type: "remote_file_upload_url_request",
        requestId: "upload-url-1",
        sessionId: "s1",
        kind: "file",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 12,
      }),
    );
    const urlRequestedAt = Date.now();
    const urlResponse = JSON.parse(await urlPromise) as {
      uploadUrl: string;
      expiresAt: number;
      success: boolean;
    };
    expect(urlResponse).toMatchObject({
      success: true,
      uploadUrl: expect.stringMatching(/^\/api\/remote-uploads\//),
    });
    expect(urlResponse.expiresAt - urlRequestedAt).toBeGreaterThanOrEqual(
      MIN_REMOTE_FILE_TOKEN_TTL_MS,
    );

    const receivedChunks: Buffer[] = [];
    let uploadId = "";
    const uploadCompletePromise = new Promise<void>((resolve, reject) => {
      const onMessage = (data: RawData, isBinary: boolean) => {
        try {
          if (isBinary) {
            const raw = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data);
            const frame = decodeFileStreamFrame(raw);
            if (frame) {
              uploadId = frame.streamId;
              receivedChunks.push(Buffer.from(frame.data));
            }
            return;
          }

          const msg = JSON.parse(data.toString()) as { type?: string; uploadId?: string };
          if (msg.type !== "remote_file_upload_stream_complete") return;
          uploadId = msg.uploadId ?? uploadId;
          proxy.off("message", onMessage);
          proxy.send(
            serializeControl({
              type: "remote_file_upload_stream_response",
              uploadId,
              sessionId: "s1",
              success: true,
              path: "/tmp/dev-anywhere/up-test.txt",
            }),
          );
          resolve();
        } catch (err) {
          proxy.off("message", onMessage);
          reject(err);
        }
      };
      proxy.on("message", onMessage);
    });

    const streamRequestPromise = waitForMessageType(proxy, "remote_file_upload_stream_request");
    const fetchPromise = fetch(`http://127.0.0.1:${port}${urlResponse.uploadUrl}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "hello upload",
    });
    const streamRequest = JSON.parse(await streamRequestPromise) as {
      uploadId: string;
      sessionId: string;
      kind: string;
      fileName: string;
      mimeType: string;
      size: number;
    };
    uploadId = streamRequest.uploadId;
    expect(streamRequest).toMatchObject({
      sessionId: "s1",
      kind: "file",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 12,
    });

    await uploadCompletePromise;
    expect(Buffer.concat(receivedChunks).toString("utf8")).toBe("hello upload");
    const res = await fetchPromise;
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sessionId: "s1",
      success: true,
      path: "/tmp/dev-anywhere/up-test.txt",
    });
  });

  it("GET /health returns 200 with status ok", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof body.uptime).toBe("number");
  });

  it("serves bundled font assets when the persistent font volume is empty", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/fonts/sarasa-fixed-sc/result.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    await expect(res.text()).resolves.toBe("/* packaged font */");
  });

  it("serves the Web UI and falls back to index.html for client-side routes", async () => {
    const root = await fetch(`http://127.0.0.1:${port}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(root.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    expect(root.headers.get("x-powered-by")).toBeNull();
    await expect(root.text()).resolves.toContain("DEV Anywhere");

    const clientRoute = await fetch(`http://127.0.0.1:${port}/chat/session-1`, {
      headers: { accept: "text/html" },
    });
    expect(clientRoute.status).toBe(200);
    expect(clientRoute.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    await expect(clientRoute.text()).resolves.toContain("DEV Anywhere");
  });

  it("uses immutable caching for hashed Web assets", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await expect(res.text()).resolves.toBe("console.log('app');");
  });

  it("does not cache the service worker", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
  });

  it("does not route unknown Relay endpoints to the Web SPA", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`, {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });

  it("GET /status returns proxy and client counts", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForCondition(() => relay.registry.listProxies().includes("p1"), "proxy not listed");

    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proxyCount: number; clientCount: number; uptime: number };
    expect(body.proxyCount).toBe(1);
    expect(typeof body.clientCount).toBe("number");
    expect(typeof body.uptime).toBe("number");
  });

  it("marks proxy offline when proxy disconnects, state preserved", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForCondition(() => relay.registry.listProxies().includes("p1"), "proxy not listed");
    expect(relay.registry.listProxies()).toContain("p1");

    proxy.close();
    await waitForCondition(() => !relay.registry.isProxyOnline("p1"), "proxy did not go offline");
    // proxy 断连后标记离线，状态永久保留等待重连
    expect(relay.registry.listProxies()).toContain("p1");
    expect(relay.registry.isProxyOnline("p1")).toBe(false);
  });

  it("rejects WebSocket upgrade on unknown path", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/unknown`);
    connections.push(ws);

    await new Promise<void>((resolve) => {
      ws.on("error", () => resolve());
      ws.on("close", () => resolve());
    });

    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });
});

describe("Relay Server Heartbeat", () => {
  it("detects and cleans up dead connections", async () => {
    const relay = createRelayServer({
      port: 0,
      heartbeatInterval: 100,
      logger,
    });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    const addr = relay.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const proxy = new WebSocket(`ws://127.0.0.1:${port}/proxy`);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "hb-test" }));
    await waitForCondition(
      () => relay.registry.listProxies().includes("hb-test"),
      "proxy not listed",
    );
    expect(relay.registry.listProxies()).toContain("hb-test");

    // 禁用 pong 响应来模拟死连接
    proxy.pong = () => {};
    proxy.on("ping", () => {
      // 不回复 pong
    });

    await waitForCondition(
      () => !relay.registry.isProxyOnline("hb-test"),
      "dead proxy was not marked offline",
      1000,
    );
    // 死连接被 terminate 后标记离线，proxyId 仍在列表但不在线
    expect(relay.registry.listProxies()).toContain("hb-test");
    expect(relay.registry.isProxyOnline("hb-test")).toBe(false);

    proxy.close();
    await relay.close();
  });
});
