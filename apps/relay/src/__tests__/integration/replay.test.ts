import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import { createLogger } from "@cc-anywhere/shared";
import { waitForOpen, waitForMessage, getPort } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

describe("replay_request protocol", () => {
  let relay: RelayServer;
  let port: number;
  const connections: WebSocket[] = [];

  beforeEach(async () => {
    relay = createRelayServer({ port: 0, heartbeatInterval: 60000, logger });
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
  });

  function connectClient(): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
    connections.push(ws);
    return ws;
  }

  it("always returns gap_unrecoverable since relay is stateless", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const replayMsg = waitForMessage(client);
    client.send(
      JSON.stringify({
        type: "replay_request",
        sessionId: "s1",
        fromSeq: 2,
        toSeq: 4,
      }),
    );

    const response = JSON.parse(await replayMsg);
    expect(response.type).toBe("gap_unrecoverable");
    expect(response.sessionId).toBe("s1");
    expect(response.fromSeq).toBe(2);
    expect(response.toSeq).toBe(4);
  });

  it("sends gap_unrecoverable for unknown sessionId", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(
      JSON.stringify({
        type: "replay_request",
        sessionId: "nonexistent-session",
        fromSeq: 1,
        toSeq: 10,
      }),
    );

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("gap_unrecoverable");
    expect(response.sessionId).toBe("nonexistent-session");
    expect(response.fromSeq).toBe(1);
    expect(response.toSeq).toBe(10);
  });

  it("sends relay_error INVALID_RANGE when fromSeq > toSeq", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(
      JSON.stringify({
        type: "replay_request",
        sessionId: "s1",
        fromSeq: 10,
        toSeq: 5,
      }),
    );

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("INVALID_RANGE");
  });
});
