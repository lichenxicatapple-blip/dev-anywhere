import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
import { getPort } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

describe("proxy endpoint token auth", () => {
  let relay: RelayServer;
  let port: number;
  const connections: WebSocket[] = [];

  async function start(proxyToken?: string, clientToken?: string): Promise<void> {
    relay = createRelayServer({
      port: 0,
      heartbeatInterval: 60000,
      logger,
      proxyToken,
      clientToken,
    });
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

    it("/client endpoint remains open unless clientToken is configured", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/client`);
      expect(ok).toBe(true);
    });
  });

  describe("with clientToken configured", () => {
    beforeEach(() => start(undefined, "client-secret"));

    it("exposes client auth requirement without exposing the token", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        auth?: { proxyTokenRequired?: boolean; clientTokenRequired?: boolean };
      };
      expect(body.auth).toEqual({
        proxyTokenRequired: false,
        clientTokenRequired: true,
      });
      expect(JSON.stringify(body)).not.toContain("client-secret");
    });

    it("validates client tokens over HTTP for explicit browser errors", async () => {
      const missing = await fetch(`http://127.0.0.1:${port}/api/auth/client`);
      expect(missing.status).toBe(401);

      const invalid = await fetch(`http://127.0.0.1:${port}/api/auth/client`, {
        headers: { authorization: "Bearer wrong" },
      });
      expect(invalid.status).toBe(401);

      const valid = await fetch(`http://127.0.0.1:${port}/api/auth/client`, {
        headers: { authorization: "Bearer client-secret" },
      });
      expect(valid.status).toBe(204);
    });

    it("accepts /client with correct ?token=", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/client?token=client-secret`);
      expect(ok).toBe(true);
    });

    it("rejects /client with wrong token", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/client?token=wrong`);
      expect(ok).toBe(false);
    });

    it("rejects /client with no token", async () => {
      const ok = await tryConnect(`ws://127.0.0.1:${port}/client`);
      expect(ok).toBe(false);
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
