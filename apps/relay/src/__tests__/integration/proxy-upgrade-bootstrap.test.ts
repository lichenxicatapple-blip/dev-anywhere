import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RelayCloseCode } from "@dev-anywhere/shared";
import { createLogger } from "@dev-anywhere/shared/logger";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { RELAY_VERSION } from "#src/version.js";
import { getPort, waitForMessage, waitForOpen } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

describe("Proxy upgrade bootstrap", () => {
  let relay: RelayServer;
  let port: number;
  const connections: WebSocket[] = [];

  beforeEach(async () => {
    relay = createRelayServer({ port: 0, heartbeatInterval: 60_000, logger });
    await new Promise<void>((resolve) => relay.httpServer.listen(0, "127.0.0.1", resolve));
    port = getPort(relay);
  });

  afterEach(async () => {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    await relay.close();
  });

  function connectProxy(): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy`);
    connections.push(ws);
    return ws;
  }

  it("returns only the Relay version and quarantines an exact 0.8.1 registration", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    const responsePromise = waitForMessage(proxy);

    proxy.send(
      JSON.stringify({
        type: "proxy_register",
        proxyId: "upgrade-source",
        name: "Old development machine",
        proxyVersion: "0.8.1",
      }),
    );

    expect(JSON.parse(await responsePromise)).toEqual({
      type: "proxy_register_response",
      status: "new",
      relayVersion: RELAY_VERSION,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(proxy.readyState).toBe(WebSocket.OPEN);
    expect(relay.registry.hasProxy("upgrade-source")).toBe(false);
  });

  it("drops follow-up traffic without registering or routing the old Proxy", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    const responsePromise = waitForMessage(proxy);

    proxy.send(
      JSON.stringify({
        type: "proxy_register",
        proxyId: "bootstrap-only",
        proxyVersion: "0.8.1",
      }),
    );
    proxy.send(
      JSON.stringify({
        type: "session_sync",
        sessions: [{ id: "must-not-route" }],
      }),
    );

    await responsePromise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(proxy.readyState).toBe(WebSocket.OPEN);
    expect(relay.registry.hasProxy("bootstrap-only")).toBe(false);
    expect(relay.registry.getProxyForSession("must-not-route")).toBeUndefined();
  });

  it.each([
    ["missing proxyVersion", { type: "proxy_register", proxyId: "missing-version" }],
    [
      "unknown field",
      {
        type: "proxy_register",
        proxyId: "extra-field",
        proxyVersion: "0.8.1",
        unexpected: true,
      },
    ],
    [
      "unstable version",
      { type: "proxy_register", proxyId: "unstable-version", proxyVersion: "0.8.1-beta.1" },
    ],
    [
      "unsupported older version",
      { type: "proxy_register", proxyId: "unsupported-version", proxyVersion: "0.8.0" },
    ],
    [
      "current version",
      { type: "proxy_register", proxyId: "current-version", proxyVersion: RELAY_VERSION },
    ],
  ])("keeps the current protocol rejection for a %s registration", async (_label, registration) => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    const responsePromise = waitForMessage(proxy);
    const closePromise = new Promise<number>((resolve) => {
      proxy.once("close", (code) => resolve(code));
    });

    proxy.send(JSON.stringify(registration));

    expect(JSON.parse(await responsePromise)).toMatchObject({
      type: "relay_error",
      code: "NOT_REGISTERED",
    });
    expect(await closePromise).toBe(RelayCloseCode.PROXY_PROTOCOL_REJECTED);
    expect(relay.registry.hasProxy(String(registration.proxyId))).toBe(false);
  });
});
