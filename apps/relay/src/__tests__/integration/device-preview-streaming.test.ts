import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayCloseCode,
  decodeDevicePreviewH264HttpPacketHeader,
  decodeDevicePreviewHttpFrameHeader,
  encodeDevicePreviewFrame,
  encodeDevicePreviewH264ProxyPacket,
  type DevicePreviewStreamProfile,
  type PreviewScope,
} from "@dev-anywhere/shared";
import { createLogger } from "@dev-anywhere/shared/logger";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { collectMessages, getPort, settle, waitForMessageType, waitForOpen } from "../helpers.js";

const logger = createLogger({ name: "device-preview-streaming-test", silent: true });
const PROXY_TOKEN = "device-proxy-secret";
const CLIENT_TOKEN = "device-client-secret";
const untrustedProxyScope = { proxyId: "forged-proxy", bindingId: "forged-binding" } as const;

type JsonMessage = Record<string, unknown> & { type: string };

describe("Device Preview Relay data plane", () => {
  let relay: RelayServer;
  let port: number;
  const sockets: WebSocket[] = [];
  const clientScopes = new WeakMap<WebSocket, PreviewScope>();

  beforeEach(async () => {
    relay = createRelayServer({
      port: 0,
      heartbeatInterval: 60_000,
      logger,
      proxyToken: PROXY_TOKEN,
      clientToken: CLIENT_TOKEN,
      webAssetDir: false,
    });
    await new Promise<void>((resolve) => relay.httpServer.listen(0, "127.0.0.1", resolve));
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

  async function setupProxy(proxyId = "device-proxy"): Promise<{
    proxy: WebSocket;
    streamTransport: WebSocket;
    connectionId: string;
  }> {
    const proxy = connect(`/proxy?token=${PROXY_TOKEN}`);
    await waitForOpen(proxy);
    const registeredPromise = waitForMessageType(proxy, "proxy_register_response");
    proxy.send(
      JSON.stringify({
        type: "proxy_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        proxyId,
        proxyVersion: "0.9.0",
      }),
    );
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
        proxyId,
        connectionId: registered.connectionId,
      }),
    );
    expect(JSON.parse(await streamRegisteredPromise)).toMatchObject({ success: true });
    return { proxy, streamTransport, connectionId: registered.connectionId };
  }

  async function selectProxy(
    client: WebSocket,
    proxyId: string,
    requestId = `select-${proxyId}`,
  ): Promise<PreviewScope> {
    const selectedPromise = waitForMessageType(client, "proxy_select_response");
    client.send(JSON.stringify({ type: "proxy_select", requestId, proxyId }));
    const selected = JSON.parse(await selectedPromise) as {
      proxyId: string;
      bindingId: string;
    };
    expect(selected).toMatchObject({ proxyId, bindingId: expect.any(String) });
    const scope = { proxyId: selected.proxyId, bindingId: selected.bindingId };
    clientScopes.set(client, scope);
    return scope;
  }

  async function setupClient(clientId: string, proxyId = "device-proxy"): Promise<WebSocket> {
    const client = connect(`/client?token=${CLIENT_TOKEN}`);
    await waitForOpen(client);
    const registeredPromise = waitForMessageType(client, "client_register_response");
    client.send(
      JSON.stringify({
        type: "client_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        clientId,
        browserName: "Safari",
        osName: "iOS",
        deviceKind: "phone",
      }),
    );
    await registeredPromise;
    await selectProxy(client, proxyId);
    return client;
  }

  function previewScope(client: WebSocket): PreviewScope {
    const scope = clientScopes.get(client);
    if (!scope) throw new Error("Test client has no Preview scope");
    return scope;
  }

  async function requestStreamUrl(
    client: WebSocket,
    requestId: string,
    previewId = "ios-preview",
    profile: DevicePreviewStreamProfile = {
      format: "jpeg",
      maxFps: 15,
    },
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
        scope: previewScope(client),
        previewId,
        profile,
      }),
    );
    const response = JSON.parse(await responsePromise);
    expect(response).toMatchObject({
      requestId,
      previewId,
      success: true,
      url: expect.any(String),
      leaseId: expect.any(String),
      scope: previewScope(client),
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
      format: "jpeg",
      maxFps: 15,
    });
    proxy.send(
      JSON.stringify({
        type: "device_preview_stream_start_response",
        streamId: start.streamId,
        leaseId: access.leaseId,
        previewId: "ios-preview",
        success: true,
        format: "jpeg",
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

  it("preserves H.264 configuration and keyframes that arrive before stream start completes", async () => {
    const { proxy, streamTransport } = await setupProxy();
    const client = await setupClient("device-client-h264");
    const access = await requestStreamUrl(client, "stream-url-h264", "android-preview", {
      format: "h264_annex_b",
    });
    const controller = new AbortController();
    const startPromise = waitForMessageType(proxy, "device_preview_stream_start");
    const responsePromise = fetch(`http://127.0.0.1:${port}${access.url}`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
      signal: controller.signal,
    });
    const start = JSON.parse(await startPromise) as JsonMessage & { streamId: string };
    expect(start).toMatchObject({
      previewId: "android-preview",
      format: "h264_annex_b",
    });
    expect(start).not.toHaveProperty("maxFps");

    const configuration = Uint8Array.of(0, 0, 0, 1, 0x67, 0x42, 0x80, 0x1f);
    const keyframe = Uint8Array.of(0, 0, 0, 1, 0x65, 0x01, 0x02);
    streamTransport.send(
      encodeDevicePreviewH264ProxyPacket(start.streamId, {
        packetSequence: 0,
        configuration: true,
        keyframe: false,
        durationMs: 0,
        annexB: configuration,
      }),
      { binary: true, compress: false },
    );
    streamTransport.send(
      encodeDevicePreviewH264ProxyPacket(start.streamId, {
        packetSequence: 1,
        configuration: false,
        keyframe: true,
        durationMs: 33,
        annexB: keyframe,
      }),
      { binary: true, compress: false },
    );
    await settle(25);
    proxy.send(
      JSON.stringify({
        type: "device_preview_stream_start_response",
        streamId: start.streamId,
        leaseId: access.leaseId,
        previewId: "android-preview",
        success: true,
        format: "h264_annex_b",
        width: 324,
        height: 720,
      }),
    );

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-device-preview-format")).toBe("h264_annex_b");
    const expectedLength =
      DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES * 2 + configuration.length + keyframe.length;
    const reader = response.body!.getReader();
    let bytes = new Uint8Array(0);
    while (bytes.length < expectedLength) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      const joined = new Uint8Array(bytes.length + chunk.value.length);
      joined.set(bytes);
      joined.set(chunk.value, bytes.length);
      bytes = joined;
    }
    const first = decodeDevicePreviewH264HttpPacketHeader(bytes);
    expect(first).toMatchObject({
      packetSequence: 0,
      configuration: true,
      keyframe: false,
      annexBLength: configuration.length,
    });
    const secondOffset = DEVICE_PREVIEW_H264_HTTP_PACKET_HEADER_BYTES + configuration.length;
    expect(decodeDevicePreviewH264HttpPacketHeader(bytes.subarray(secondOffset))).toMatchObject({
      packetSequence: 1,
      configuration: false,
      keyframe: true,
      annexBLength: keyframe.length,
    });

    const stopPromise = waitForMessageType(proxy, "device_preview_stream_stop");
    await reader.cancel();
    controller.abort();
    expect(JSON.parse(await stopPromise)).toMatchObject({
      streamId: start.streamId,
      reason: "client_closed",
    });
  });

  it("fails closed when Proxy returns a format different from the requested format", async () => {
    const { proxy } = await setupProxy();
    const client = await setupClient("device-client-h264-negotiation-mismatch");
    const access = await requestStreamUrl(
      client,
      "stream-url-h264-negotiation-mismatch",
      "android-preview",
      { format: "h264_annex_b" },
    );
    const startPromise = waitForMessageType(proxy, "device_preview_stream_start");
    const responsePromise = fetch(`http://127.0.0.1:${port}${access.url}`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    const start = JSON.parse(await startPromise) as JsonMessage & { streamId: string };
    expect(start).toMatchObject({ format: "h264_annex_b" });

    const stopPromise = waitForMessageType(proxy, "device_preview_stream_stop");
    proxy.send(
      JSON.stringify({
        type: "device_preview_stream_start_response",
        streamId: start.streamId,
        leaseId: access.leaseId,
        previewId: "android-preview",
        success: true,
        format: "jpeg",
      }),
    );

    const response = await responsePromise;
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("返回了错误的设备画面格式"),
    });
    expect(JSON.parse(await stopPromise)).toMatchObject({
      streamId: start.streamId,
      reason: "stream_error",
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
        format: "jpeg",
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
        scope: previewScope(clientA),
        operationId: "device-operation-a",
        targetId: "ios:simulator-a",
      }),
    );
    clientB.send(
      JSON.stringify({
        type: "device_preview_create_request",
        requestId: "same-browser-request",
        scope: previewScope(clientB),
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
    expect(requestA?.scope).toEqual(previewScope(clientA));
    expect(requestB?.scope).toEqual(previewScope(clientB));

    const responseA = waitForMessageType(clientA, "device_preview_create_response");
    const responseB = waitForMessageType(clientB, "device_preview_create_response");
    proxy.send(
      JSON.stringify({
        type: "device_preview_create_response",
        requestId: requestB?.requestId,
        scope: untrustedProxyScope,
        operationId: "device-operation-b",
        accepted: true,
        previewId: "preview-b",
      }),
    );
    proxy.send(
      JSON.stringify({
        type: "device_preview_create_response",
        requestId: requestA?.requestId,
        scope: untrustedProxyScope,
        operationId: "device-operation-a",
        accepted: true,
        previewId: "preview-a",
      }),
    );
    expect(JSON.parse(await responseA)).toMatchObject({
      requestId: "same-browser-request",
      operationId: "device-operation-a",
      previewId: "preview-a",
      scope: previewScope(clientA),
    });
    expect(JSON.parse(await responseB)).toMatchObject({
      requestId: "same-browser-request",
      operationId: "device-operation-b",
      previewId: "preview-b",
      scope: previewScope(clientB),
    });
  });

  it("rejects a stale binding generation before routing Device Preview management", async () => {
    const { proxy } = await setupProxy();
    const client = await setupClient("device-stale-binding");
    const staleScope = previewScope(client);

    const selectedPromise = waitForMessageType(client, "proxy_select_response");
    client.send(
      JSON.stringify({
        type: "proxy_select",
        requestId: "device-reselect",
        proxyId: "device-proxy",
      }),
    );
    const selected = JSON.parse(await selectedPromise) as {
      proxyId: string;
      bindingId: string;
    };
    expect(selected.bindingId).not.toBe(staleScope.bindingId);

    const proxyMessages: JsonMessage[] = [];
    proxy.on("message", (data) => proxyMessages.push(JSON.parse(data.toString()) as JsonMessage));
    const staleError = waitForMessageType(client, "relay_error");
    client.send(
      JSON.stringify({
        type: "device_preview_list_request",
        requestId: "device-list-stale",
        scope: staleScope,
      }),
    );
    expect(JSON.parse(await staleError)).toMatchObject({
      requestId: "device-list-stale",
      code: "STALE_BINDING",
    });
    await settle(50);
    expect(proxyMessages).toEqual([]);

    const currentScope = { proxyId: selected.proxyId, bindingId: selected.bindingId };
    const forwarded = waitForMessageType(proxy, "device_preview_list_request");
    client.send(
      JSON.stringify({
        type: "device_preview_list_request",
        requestId: "device-list-current",
        scope: currentScope,
      }),
    );
    expect(JSON.parse(await forwarded)).toMatchObject({
      type: "device_preview_list_request",
      scope: currentScope,
    });
  });

  it.each([
    ["same Proxy rebind", false],
    ["cross-Proxy switch with the same previewId", true],
  ])("rejects stale Device stream and control scope after %s", async (_label, crossProxy) => {
    await setupProxy("device-proxy-a");
    if (crossProxy) await setupProxy("device-proxy-b");
    const client = await setupClient("device-data-stale-binding", "device-proxy-a");
    const staleScope = previewScope(client);
    const currentScope = await selectProxy(
      client,
      crossProxy ? "device-proxy-b" : "device-proxy-a",
      "device-data-reselect",
    );
    expect(currentScope.bindingId).not.toBe(staleScope.bindingId);

    const staleUrlError = waitForMessageType(client, "relay_error");
    client.send(
      JSON.stringify({
        type: "device_preview_stream_url_request",
        requestId: "stale-stream-url",
        scope: staleScope,
        previewId: "shared-preview-id",
        profile: { format: "jpeg" },
      }),
    );
    expect(JSON.parse(await staleUrlError)).toMatchObject({
      requestId: "stale-stream-url",
      code: "STALE_BINDING",
    });

    const access = await requestStreamUrl(client, "current-stream-url", "shared-preview-id", {
      format: "jpeg",
    });
    expect(access.controlMode).toBe("controller");

    const staleInputError = waitForMessageType(client, "device_preview_input_ack");
    client.send(
      JSON.stringify({
        type: "device_preview_input",
        scope: staleScope,
        leaseId: access.leaseId,
        inputSeq: 1,
        input: { kind: "button", button: "home" },
      }),
    );
    expect(JSON.parse(await staleInputError)).toMatchObject({
      scope: staleScope,
      leaseId: access.leaseId,
      inputSeq: 1,
      success: false,
      error: "Preview request used a stale client binding",
      errorCode: "CONTROL_LEASE_INVALID",
    });

    const staleClaimError = waitForMessageType(client, "relay_error");
    client.send(
      JSON.stringify({
        type: "device_preview_control_claim_request",
        requestId: "stale-control-claim",
        scope: staleScope,
        leaseId: access.leaseId,
      }),
    );
    expect(JSON.parse(await staleClaimError)).toMatchObject({
      requestId: "stale-control-claim",
      code: "STALE_BINDING",
    });
  });

  it("preserves operationId while rewriting Device Preview rename request IDs", async () => {
    const { proxy } = await setupProxy();
    const client = await setupClient("device-rename-routing");
    const forwardedPromise = waitForMessageType(proxy, "device_preview_rename_request");
    client.send(
      JSON.stringify({
        type: "device_preview_rename_request",
        requestId: "device-rename-client-request",
        scope: previewScope(client),
        operationId: "device-rename-operation-1",
        previewId: "preview-1",
        name: "QA phone",
      }),
    );
    const forwarded = JSON.parse(await forwardedPromise);
    expect(forwarded).toMatchObject({
      requestId: expect.stringMatching(/^relay-device-preview-/u),
      operationId: "device-rename-operation-1",
    });

    const responsePromise = waitForMessageType(client, "device_preview_rename_response");
    proxy.send(
      JSON.stringify({
        type: "device_preview_rename_response",
        requestId: forwarded.requestId,
        scope: untrustedProxyScope,
        operationId: forwarded.operationId,
        previewId: "preview-1",
        success: true,
      }),
    );
    expect(JSON.parse(await responsePromise)).toMatchObject({
      requestId: "device-rename-client-request",
      operationId: "device-rename-operation-1",
      success: true,
      scope: previewScope(client),
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
        scope: untrustedProxyScope,
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
        scope: untrustedProxyScope,
        leaseId: "forged-lease",
        success: true,
        controlMode: "controller",
      }),
    );
    proxy.send(
      JSON.stringify({
        type: "device_preview_control_revoked_push",
        scope: { proxyId: "device-proxy", bindingId: "forged-binding" },
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

  it("keeps input sequence monotonic across controller takeover and ignores delayed ACKs", async () => {
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
        scope: previewScope(clientA),
        leaseId: accessA.leaseId,
        inputSeq: 1,
        input: { kind: "button", button: "home" },
      }),
    );
    expect(JSON.parse(await forwardedInputPromise)).toMatchObject({
      leaseId: accessA.leaseId,
      inputSeq: 1,
      input: { kind: "button", button: "home" },
    });

    const rejectedInputPromise = waitForMessageType(clientB, "device_preview_input_ack");
    const unexpectedProxyInput = collectMessages(proxy, 1, 100);
    clientB.send(
      JSON.stringify({
        type: "device_preview_input",
        scope: previewScope(clientB),
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
    const revokedInputAckPromise = waitForMessageType(clientA, "device_preview_input_ack");
    const claimedPromise = waitForMessageType(clientB, "device_preview_control_claim_response");
    const inputRevokePromise = waitForMessageType(proxy, "device_preview_input_revoke");
    clientB.send(
      JSON.stringify({
        type: "device_preview_control_claim_request",
        requestId: "claim-b",
        scope: previewScope(clientB),
        leaseId: accessB.leaseId,
      }),
    );
    expect(JSON.parse(await revokedPromise)).toMatchObject({
      scope: previewScope(clientA),
      leaseId: accessA.leaseId,
      reason: "taken_over",
    });
    expect(JSON.parse(await revokedInputAckPromise)).toMatchObject({
      leaseId: accessA.leaseId,
      inputSeq: 1,
      success: false,
      errorCode: "CONTROL_LEASE_INVALID",
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
        scope: previewScope(clientA),
        leaseId: accessA.leaseId,
      }),
    );
    expect(JSON.parse(await inputRevokeBPromise)).toMatchObject({ leaseId: accessB.leaseId });
    expect(JSON.parse(await revokedBPromise)).toMatchObject({
      scope: previewScope(clientB),
      leaseId: accessB.leaseId,
      reason: "taken_over",
    });
    expect(JSON.parse(await reclaimedPromise)).toMatchObject({
      requestId: "claim-a-again",
      success: true,
      controlMode: "controller",
    });

    const staleSequenceAckPromise = waitForMessageType(clientA, "device_preview_input_ack");
    const unexpectedReusedInput = collectMessages(proxy, 1, 100);
    clientA.send(
      JSON.stringify({
        type: "device_preview_input",
        scope: previewScope(clientA),
        leaseId: accessA.leaseId,
        inputSeq: 1,
        input: { kind: "button", button: "home" },
      }),
    );
    expect(JSON.parse(await staleSequenceAckPromise)).toMatchObject({
      leaseId: accessA.leaseId,
      inputSeq: 1,
      success: false,
    });
    expect(await unexpectedReusedInput).toEqual([]);

    const resumedInputPromise = waitForMessageType(proxy, "device_preview_input");
    clientA.send(
      JSON.stringify({
        type: "device_preview_input",
        scope: previewScope(clientA),
        leaseId: accessA.leaseId,
        inputSeq: 2,
        input: { kind: "button", button: "home" },
      }),
    );
    expect(JSON.parse(await resumedInputPromise)).toMatchObject({
      leaseId: accessA.leaseId,
      inputSeq: 2,
    });

    const unexpectedDelayedAck = collectMessages(clientA, 1, 100);
    proxy.send(
      JSON.stringify({
        type: "device_preview_input_ack",
        scope: untrustedProxyScope,
        leaseId: accessA.leaseId,
        inputSeq: 1,
        success: true,
      }),
    );
    expect(await unexpectedDelayedAck).toEqual([]);

    const currentInputAckPromise = waitForMessageType(clientA, "device_preview_input_ack");
    proxy.send(
      JSON.stringify({
        type: "device_preview_input_ack",
        scope: untrustedProxyScope,
        leaseId: accessA.leaseId,
        inputSeq: 2,
        success: true,
      }),
    );
    expect(JSON.parse(await currentInputAckPromise)).toMatchObject({
      leaseId: accessA.leaseId,
      inputSeq: 2,
      success: true,
      scope: previewScope(clientA),
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
          scope: previewScope(client),
          leaseId: access.leaseId,
          inputSeq,
          input: { kind: "button", button: "home" },
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
