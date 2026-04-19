import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import { createLogger } from "@cc-anywhere/shared";
import { getPort } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

describe("proxy endpoint token auth", () => {
  let relay: RelayServer;
  let port: number;
  const connections: WebSocket[] = [];

  async function start(proxyToken?: string): Promise<void> {
    relay = createRelayServer({ port: 0, heartbeatInterval: 60000, logger, proxyToken });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    port = getPort(relay);
  }

  afterEach(async () => {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    connections.length = 0;
    await relay.close();
  });

  // 返回 WS 开启成功与否的 Promise; true = open, false = 被 relay 拒绝 (含 401 / destroy)
  async function tryConnect(url: string): Promise<boolean> {
    const ws = new WebSocket(url);
    connections.push(ws);
    return new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("error", () => resolve(false));
      ws.once("close", () => resolve(false));
    });
  }

  describe("with proxyToken configured", () => {
    beforeEach(() => start("secret-abc"));

    it("accepts /proxy with correct ?token=", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/proxy?token=secret-abc`);
      expect(ok).toBe(true);
    });

    it("rejects /proxy with wrong token", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/proxy?token=wrong`);
      expect(ok).toBe(false);
    });

    it("rejects /proxy with no token", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/proxy`);
      expect(ok).toBe(false);
    });

    it("/client endpoint is unaffected (no token required)", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/client`);
      expect(ok).toBe(true);
    });
  });

  describe("without proxyToken (dev default)", () => {
    beforeEach(() => start());

    it("accepts /proxy without token", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/proxy`);
      expect(ok).toBe(true);
    });
  });
});
