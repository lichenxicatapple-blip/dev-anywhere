import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  RelayCloseCode,
  decodeDevicePreviewHttpFrameHeader,
  encodeDevicePreviewFrame,
} from "@dev-anywhere/shared";
import { createLogger } from "@dev-anywhere/shared/logger";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { collectMessages, getPort, settle, waitForMessageType, waitForOpen } from "../helpers.js";

const logger = createLogger({ name: "device-preview-streaming-test", silent: true });
const PROXY_TOKEN = "device-proxy-secret";
const CLIENT_TOKEN = "device-client-secret";

type JsonMessage = Record<string, unknown> & { type: string };

describe("Device Preview Relay data plane", () => {
  let relay: RelayServer;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    relay = createRelayServer({
      port: 0,
      heartbeatInterval: 60_000,
      logger,
      proxyToken: PROXY_TOKEN,
      clientToken: CLIENT_TOKEN,
      webAssetDir: false,
    });
    await new Promise<void>((resolve) => relay.httpServer.listen(0, resolve));
    port = getPort(relay);
  });

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    sockets.length = 0;
    await relay.close();
  });

  function connect(path: string): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sockets.push(ws);
    return ws;
  }

  async function setupProxy(): Promise<{
    proxy: WebSocket;
    streamTransport: WebSocket;
    connectionId: string;
  }> {
    const proxy = connect(`/proxy?token=${PROXY_TOKEN}`);
    await waitForOpen(proxy);
    const registeredPromise = waitForMessageType(proxy, "proxy_register_response");
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "device-proxy" }));
    const registered = JSON.parse(await registeredPromise) as JsonMessage & {
      connectionId: string;
    };
    expect(registered.connectionId).toEqual(expect.any(String));

    const streamTransport = connect(`/proxy-stream?token=${PROXY_TOKEN}`);
    await waitForOpen(streamTransport);
    const streamRegisteredPromise = waitForMessageType(
      streamTransport,
      "device_preview_stream_register_response",
    );
    streamTransport.send(
      JSON.stringify({
        type: "device_preview_stream_register",
        proxyId: "device-proxy",
        connectionId: registered.connectionId,
      }),
    );
    expect(JSON.parse(await streamRegisteredPromise)).toMatchObject({ success: true });
    return { proxy, streamTransport, connectionId: registered.connectionId };
  }

  async function setupClient(clientId: string): Promise<WebSocket> {
    const client = connect(`/client?token=${CLIENT_TOKEN}`);
    await waitForOpen(client);
    const registeredPromise = waitForMessageType(client, "client_register_response");
    client.send(
      JSON.stringify({
        type: "client_register",
        clientId,
        browserName: "Safari",
        osName: "iOS",
        deviceKind: "phone",
      }),
    );
    await registeredPromise;
    const selectedPromise = waitForMessageType(client, "proxy_select_response");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "device-proxy" }));
    await selectedPromise;
    return client;
  }

  async function requestStreamUrl(
    client: WebSocket,
    requestId: string,
    previewId = "ios-preview",
  ): Promise<
    JsonMessage & {
      url: string;
      leaseId: string;
      controlMode: "controller" | "view_only";
    }
  > {
    const responsePromise = waitForMessageType(client, "device_preview_stream_url_response");
    client.send(
      JSON.stringify({
        type: "device_preview_stream_url_request",
        requestId,
        previewId,
        profile: { maxFps: 15, maxWidth: 960, jpegQuality: 70 },
      }),
    );
    const response = JSON.parse(await responsePromise);
    expect(response).toMatchObject({
      requestId,
      previewId,
      success: true,
      url: expect.any(String),
      leaseId: expect.any(String),
    });
    return response;
  }

  async function startHttpStream(
    proxy: WebSocket,
    access: { url: string; leaseId: string },
    signal?: AbortSignal,
  ): Promise<{ response: Response; start: JsonMessage & { streamId: string } }> {
    const startPromise = waitForMessageType(proxy, "device_preview_stream_start");
    const responsePromise = fetch(`http://127.0.0.1:${port}${access.url}`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
      signal,
    });
    const start = JSON.parse(await startPromise) as JsonMessage & { streamId: string };
    expect(start).toMatchObject({
      leaseId: access.leaseId,
      previewId: "ios-preview",
      maxFps: 15,
      maxWidth: 960,
      jpegQuality: 70,
    });
    proxy.send(
      JSON.stringify({
        type: "device_preview_stream_start_response",
        streamId: start.streamId,
        leaseId: access.leaseId,
        previewId: "ios-preview",
        success: true,
        width: 1179,
        height: 2556,
      }),
    );
    return { response: await responsePromise, start };
  }

  it("authenticates, consumes a URL once, and routes exact framed JPEG bytes", async () => {
    const { proxy, streamTransport } = await setupProxy();
    const client = await setupClient("device-client-a");
    const access = await requestStreamUrl(client, "stream-url-a");

    // The long-lived Client token is a second factor. A failed check must not consume the
    // short-lived stream token.
    const unauthorized = await fetch(`http://127.0.0.1:${port}${access.url}`);
    expect(unauthorized.status).toBe(401);

    const controller = new AbortController();
    const { response, start } = await startHttpStream(proxy, access, controller.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-dev-anywhere-device-preview");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-device-width")).toBe("1179");

    const replay = await fetch(`http://127.0.0.1:${port}${access.url}`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(replay.status).toBe(404);

    const jpeg = Uint8Array.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
    streamTransport.send(encodeDevicePreviewFrame(start.streamId, 7, jpeg), {
      binary: true,
      compress: false,
    });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    let record = new Uint8Array(0);
    while (record.length < 8 + jpeg.length) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      const joined = new Uint8Array(record.length + chunk.value.length);
      joined.set(record);
      joined.set(chunk.value, record.length);
      record = joined;
    }
    expect(decodeDevicePreviewHttpFrameHeader(record)).toEqual({
      jpegLength: jpeg.length,
      frameSequence: 7,
    });
    expect(record.slice(8, 8 + jpeg.length)).toEqual(jpeg);

    const stopPromise = waitForMessageType(proxy, "device_preview_stream_stop");
    await reader!.cancel();
    controller.abort();
    expect(JSON.parse(await stopPromise)).toMatchObject({
      streamId: start.streamId,
      reason: "client_closed",
    });
  });

  it("flushes the newest frame that arrives before the stream-start response", async () => {
    const { proxy, streamTransport } = await setupProxy();
    const client = await setupClient("device-client-cached-first-frame");
    const access = await requestStreamUrl(client, "stream-url-cached-first-frame");
    const controller = new AbortController();
    const startPromise = waitForMessageType(proxy, "device_preview_stream_start");
    const responsePromise = fetch(`http://127.0.0.1:${port}${access.url}`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
      signal: controller.signal,
    });
    const start = JSON.parse(await startPromise) as JsonMessage & { streamId: string };
    const first = Uint8Array.from([0xff, 0xd8, 0x11, 0xff, 0xd9]);
    const newest = Uint8Array.from([0xff, 0xd8, 0x22, 0xff, 0xd9]);
    const outOfOrder = Uint8Array.from([0xff, 0xd8, 0x33, 0xff, 0xd9]);
    streamTransport.send(encodeDevicePreviewFrame(start.streamId, 1, first), {
      binary: true,
      compress: false,
    });
    streamTransport.send(encodeDevicePreviewFrame(start.streamId, 3, newest), {
      binary: true,
      compress: false,
    });
    streamTransport.send(encodeDevicePreviewFrame(start.streamId, 2, outOfOrder), {
      binary: true,
      compress: false,
    });
    await settle(25);

    proxy.send(
      JSON.stringify({
        type: "device_preview_stream_start_response",
        streamId: start.streamId,
        leaseId: access.leaseId,
        previewId: "ios-preview",
        success: true,
        width: 1179,
        height: 2556,
      }),
    );

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    let record = new Uint8Array(0);
    while (record.length < 8 + newest.length) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      const joined = new Uint8Array(record.length + chunk.value.length);
      joined.set(record);
      joined.set(chunk.value, record.length);
      record = joined;
    }
    expect(decodeDevicePreviewHttpFrameHeader(record)).toEqual({
      jpegLength: newest.length,
      frameSequence: 3,
    });
    expect(record.slice(8, 8 + newest.length)).toEqual(newest);

    const stopPromise = waitForMessageType(proxy, "device_preview_stream_stop");
    await reader!.cancel();
    controller.abort();
    expect(JSON.parse(await stopPromise)).toMatchObject({
      streamId: start.streamId,
      reason: "client_closed",
    });
  });

  it("routes colliding management request IDs only to their initiating sockets", async () => {
    const { proxy } = await setupProxy();
    const clientA = await setupClient("device-route-a");
    const clientB = await setupClient("device-route-b");
    const requestsPromise = collectMessages(proxy, 2, 1_000);

    clientA.send(
      JSON.stringify({
        type: "device_preview_create_request",
        requestId: "same-browser-request",
        operationId: "device-operation-a",
        targetId: "ios:simulator-a",
      }),
    );
    clientB.send(
      JSON.stringify({
        type: "device_preview_create_request",
        requestId: "same-browser-request",
        operationId: "device-operation-b",
        targetId: "android:emulator-b",
      }),
    );
    const requests = (await requestsPromise).map((raw) => JSON.parse(raw) as JsonMessage);
    const requestA = requests.find((message) => message.operationId === "device-operation-a");
    const requestB = requests.find((message) => message.operationId === "device-operation-b");
    expect(requestA?.requestId).toMatch(/^relay-device-preview-/u);
    expect(requestB?.requestId).toMatch(/^relay-device-preview-/u);
    expect(requestA?.requestId).not.toBe(requestB?.requestId);

    const responseA = waitForMessageType(clientA, "device_preview_create_response");
    const responseB = waitForMessageType(clientB, "device_preview_create_response");
    proxy.send(
      JSON.stringify({
        type: "device_preview_create_response",
        requestId: requestB?.requestId,
        operationId: "device-operation-b",
        accepted: true,
        previewId: "preview-b",
      }),
    );
    proxy.send(
      JSON.stringify({
        type: "device_preview_create_response",
        requestId: requestA?.requestId,
        operationId: "device-operation-a",
        accepted: true,
        previewId: "preview-a",
      }),
    );
    expect(JSON.parse(await responseA)).toMatchObject({
      requestId: "same-browser-request",
      operationId: "device-operation-a",
      previewId: "preview-a",
    });
    expect(JSON.parse(await responseB)).toMatchObject({
      requestId: "same-browser-request",
      operationId: "device-operation-b",
      previewId: "preview-b",
    });
  });

  it("never forwards Relay-internal stream lifecycle messages from a malicious client", async () => {
    const { proxy } = await setupProxy();
    const client = await setupClient("device-malicious-client");
    const unexpectedProxyMessages = collectMessages(proxy, 1, 150);

    client.send(
      JSON.stringify({
        type: "device_preview_stream_start",
        streamId: "forged-stream",
        leaseId: "forged-lease",
        previewId: "forged-preview",
      }),
    );
    client.send(
      JSON.stringify({
        type: "device_preview_stream_stop",
        streamId: "forged-stream",
        reason: "client_closed",
      }),
    );

    expect(await unexpectedProxyMessages).toEqual([]);
  });

  it("swallows Relay-local device responses forged by a malicious Proxy", async () => {
    const { proxy } = await setupProxy();
    const client = await setupClient("device-forged-proxy-response");
    const unexpectedClientMessages = collectMessages(client, 1, 150);

    proxy.send(
      JSON.stringify({
        type: "device_preview_stream_url_response",
        requestId: "forged-url",
        previewId: "forged-preview",
        success: true,
        url: "/api/device-preview-streams/forged",
        leaseId: "forged-lease",
        expiresAt: Date.now() + 20_000,
        controlMode: "controller",
      }),
    );
    proxy.send(
      JSON.stringify({
        type: "device_preview_control_claim_response",
        requestId: "forged-claim",
        leaseId: "forged-lease",
        success: true,
        controlMode: "controller",
      }),
    );
    proxy.send(
      JSON.stringify({
        type: "device_preview_control_revoked_push",
        leaseId: "forged-lease",
        reason: "taken_over",
      }),
    );

    expect(await unexpectedClientMessages).toEqual([]);
  });

  it("rejects a stale dedicated transport binding and requires the Proxy token", async () => {
    const { connectionId } = await setupProxy();

    const unauthorized = connect("/proxy-stream?token=wrong");
    await expect(waitForOpen(unauthorized)).rejects.toBeDefined();

    const stale = connect(`/proxy-stream?token=${PROXY_TOKEN}`);
    await waitForOpen(stale);
    const rejectedPromise = waitForMessageType(stale, "device_preview_stream_register_response");
    const closedPromise = new Promise<number>((resolve) => stale.once("close", resolve));
    stale.send(
      JSON.stringify({
        type: "device_preview_stream_register",
        proxyId: "device-proxy",
        connectionId: `${connectionId}-stale`,
      }),
    );
    expect(JSON.parse(await rejectedPromise)).toMatchObject({ success: false });
    expect(await closedPromise).toBe(RelayCloseCode.DEVICE_STREAM_BINDING_REJECTED);
  });

  it("stops active Proxy viewers when a dedicated transport is replaced", async () => {
    const { proxy, connectionId } = await setupProxy();
    const client = await setupClient("device-client-transport-replace");
    const access = await requestStreamUrl(client, "stream-url-before-replace");
    const controller = new AbortController();
    const active = await startHttpStream(proxy, access, controller.signal);

    const stopPromise = waitForMessageType(proxy, "device_preview_stream_stop");
    const replacement = connect(`/proxy-stream?token=${PROXY_TOKEN}`);
    await waitForOpen(replacement);
    const registeredPromise = waitForMessageType(
      replacement,
      "device_preview_stream_register_response",
    );
    replacement.send(
      JSON.stringify({
        type: "device_preview_stream_register",
        proxyId: "device-proxy",
        connectionId,
      }),
    );
    expect(JSON.parse(await registeredPromise)).toMatchObject({ success: true });
    expect(JSON.parse(await stopPromise)).toMatchObject({
      streamId: active.start.streamId,
      reason: "stream_error",
    });

    // The failed stream's lease slot is released, and the replacement transport can serve a new
    // request without waiting for the old HTTP idle timeout.
    const retry = await requestStreamUrl(client, "stream-url-after-replace");
    expect(retry.controlMode).toBe("controller");
    controller.abort();
    await active.response.body?.cancel().catch(() => undefined);
  });

  it("stops capture over the main control socket when the data socket disconnects", async () => {
    const { proxy, streamTransport } = await setupProxy();
    const client = await setupClient("device-client-transport-close");
    const access = await requestStreamUrl(client, "stream-url-before-close");
    const controller = new AbortController();
    const active = await startHttpStream(proxy, access, controller.signal);

    const stopPromise = waitForMessageType(proxy, "device_preview_stream_stop");
    streamTransport.close();
    expect(JSON.parse(await stopPromise)).toMatchObject({
      streamId: active.start.streamId,
      reason: "stream_error",
    });

    controller.abort();
    await active.response.body?.cancel().catch(() => undefined);
  });

  it("revokes a private stream when the same clientId reconnects on a new socket", async () => {
    const { proxy } = await setupProxy();
    const firstSocket = await setupClient("device-client-reconnect");
    const access = await requestStreamUrl(firstSocket, "stream-url-before-client-reconnect");
    const controller = new AbortController();
    const active = await startHttpStream(proxy, access, controller.signal);

    const stopPromise = waitForMessageType(proxy, "device_preview_stream_stop");
    await setupClient("device-client-reconnect");
    expect(JSON.parse(await stopPromise)).toMatchObject({
      streamId: active.start.streamId,
      reason: "client_closed",
    });

    controller.abort();
    await active.response.body?.cancel().catch(() => undefined);
  });

  it("supersedes only an unconsumed URL lease for the same client and preview", async () => {
    await setupProxy();
    const client = await setupClient("device-client-race");
    const first = await requestStreamUrl(client, "stream-url-first");
    const second = await requestStreamUrl(client, "stream-url-second");

    expect(second.leaseId).not.toBe(first.leaseId);
    expect(second.controlMode).toBe("controller");
    const stale = await fetch(`http://127.0.0.1:${port}${first.url}`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(stale.status).toBe(404);
  });

  it("returns the Proxy's stream-start failure as an HTTP status and releases the lease", async () => {
    const { proxy } = await setupProxy();
    const client = await setupClient("device-client-start-failure");
    const access = await requestStreamUrl(client, "stream-url-start-failure");
    const startPromise = waitForMessageType(proxy, "device_preview_stream_start");
    const responsePromise = fetch(`http://127.0.0.1:${port}${access.url}`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    const start = JSON.parse(await startPromise) as JsonMessage & { streamId: string };
    proxy.send(
      JSON.stringify({
        type: "device_preview_stream_start_response",
        streamId: start.streamId,
        leaseId: access.leaseId,
        previewId: "ios-preview",
        success: false,
        errorCode: "STREAM_CAPACITY_EXCEEDED",
        error: "设备采集已达到上限",
      }),
    );

    const response = await responsePromise;
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "设备采集已达到上限" });

    // A failed start must not leave the per-client lease slot occupied.
    const retry = await requestStreamUrl(client, "stream-url-after-failure");
    expect(retry.success).toBe(true);
  });

  it("keeps input on the exact live lease and supports explicit controller takeover", async () => {
    const { proxy } = await setupProxy();
    const clientA = await setupClient("device-control-a");
    const clientB = await setupClient("device-control-b");
    const accessA = await requestStreamUrl(clientA, "url-control-a");
    const abortA = new AbortController();
    const streamA = await startHttpStream(proxy, accessA, abortA.signal);
    expect(accessA.controlMode).toBe("controller");

    const forwardedInputPromise = waitForMessageType(proxy, "device_preview_input");
    clientA.send(
      JSON.stringify({
        type: "device_preview_input",
        leaseId: accessA.leaseId,
        inputSeq: 1,
        input: { kind: "tap", x: 0.25, y: 0.75 },
      }),
    );
    expect(JSON.parse(await forwardedInputPromise)).toMatchObject({
      leaseId: accessA.leaseId,
      inputSeq: 1,
      input: { kind: "tap", x: 0.25, y: 0.75 },
    });

    const rejectedInputPromise = waitForMessageType(clientB, "device_preview_input_ack");
    const unexpectedProxyInput = collectMessages(proxy, 1, 100);
    clientB.send(
      JSON.stringify({
        type: "device_preview_input",
        leaseId: accessA.leaseId,
        inputSeq: 2,
        input: { kind: "button", button: "home" },
      }),
    );
    expect(JSON.parse(await rejectedInputPromise)).toMatchObject({
      success: false,
      errorCode: "CONTROL_LEASE_INVALID",
    });
    expect(await unexpectedProxyInput).toEqual([]);

    const accessB = await requestStreamUrl(clientB, "url-control-b");
    const abortB = new AbortController();
    const streamB = await startHttpStream(proxy, accessB, abortB.signal);
    expect(accessB.controlMode).toBe("view_only");

    const revokedPromise = waitForMessageType(clientA, "device_preview_control_revoked_push");
    const claimedPromise = waitForMessageType(clientB, "device_preview_control_claim_response");
    const inputRevokePromise = waitForMessageType(proxy, "device_preview_input_revoke");
    clientB.send(
      JSON.stringify({
        type: "device_preview_control_claim_request",
        requestId: "claim-b",
        leaseId: accessB.leaseId,
      }),
    );
    expect(JSON.parse(await revokedPromise)).toMatchObject({
      leaseId: accessA.leaseId,
      reason: "taken_over",
    });
    expect(JSON.parse(await inputRevokePromise)).toEqual({
      type: "device_preview_input_revoke",
      leaseId: accessA.leaseId,
      reason: "control_taken_over",
    });
    expect(JSON.parse(await claimedPromise)).toMatchObject({
      requestId: "claim-b",
      success: true,
      controlMode: "controller",
    });

    const revokedBPromise = waitForMessageType(clientB, "device_preview_control_revoked_push");
    const reclaimedPromise = waitForMessageType(clientA, "device_preview_control_claim_response");
    const inputRevokeBPromise = waitForMessageType(proxy, "device_preview_input_revoke");
    clientA.send(
      JSON.stringify({
        type: "device_preview_control_claim_request",
        requestId: "claim-a-again",
        leaseId: accessA.leaseId,
      }),
    );
    expect(JSON.parse(await inputRevokeBPromise)).toMatchObject({ leaseId: accessB.leaseId });
    expect(JSON.parse(await revokedBPromise)).toMatchObject({
      leaseId: accessB.leaseId,
      reason: "taken_over",
    });
    expect(JSON.parse(await reclaimedPromise)).toMatchObject({
      requestId: "claim-a-again",
      success: true,
      controlMode: "controller",
    });

    const resumedInputPromise = waitForMessageType(proxy, "device_preview_input");
    clientA.send(
      JSON.stringify({
        type: "device_preview_input",
        leaseId: accessA.leaseId,
        inputSeq: 1,
        input: { kind: "button", button: "home" },
      }),
    );
    expect(JSON.parse(await resumedInputPromise)).toMatchObject({
      leaseId: accessA.leaseId,
      inputSeq: 1,
    });

    abortA.abort();
    abortB.abort();
    await Promise.allSettled([streamA.response.body?.cancel(), streamB.response.body?.cancel()]);
    await settle(25);
  });

  it("bounds unacknowledged input per lease", async () => {
    const { proxy } = await setupProxy();
    const client = await setupClient("device-input-cap");
    const access = await requestStreamUrl(client, "url-input-cap");
    const controller = new AbortController();
    const active = await startHttpStream(proxy, access, controller.signal);
    const forwardedPromise = collectMessages(proxy, 32, 1_000);
    const rejectedPromise = waitForMessageType(client, "device_preview_input_ack");

    for (let inputSeq = 1; inputSeq <= 33; inputSeq += 1) {
      client.send(
        JSON.stringify({
          type: "device_preview_input",
          leaseId: access.leaseId,
          inputSeq,
          input: { kind: "tap", x: 0.5, y: 0.5 },
        }),
      );
    }

    const forwarded = (await forwardedPromise).map((raw) => JSON.parse(raw) as JsonMessage);
    expect(forwarded).toHaveLength(32);
    expect(forwarded.every((message) => message.type === "device_preview_input")).toBe(true);
    expect(JSON.parse(await rejectedPromise)).toMatchObject({
      type: "device_preview_input_ack",
      leaseId: access.leaseId,
      inputSeq: 33,
      success: false,
      errorCode: "RATE_LIMITED",
    });

    controller.abort();
    await active.response.body?.cancel().catch(() => undefined);
  });
});
