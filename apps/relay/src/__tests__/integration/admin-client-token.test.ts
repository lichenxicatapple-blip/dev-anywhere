import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { createLogger } from "@dev-anywhere/shared";
import { getPort } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

describe("/admin/client-token endpoint", () => {
  let relay: RelayServer;
  let port: number;

  async function start(opts: { proxyToken?: string; clientToken?: string }): Promise<void> {
    relay = createRelayServer({
      port: 0,
      heartbeatInterval: 60000,
      logger,
      ...opts,
    });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    port = getPort(relay);
  }

  async function get(token?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    return await fetch(`http://127.0.0.1:${port}/admin/client-token`, { headers });
  }

  afterEach(async () => {
    await relay.close();
  });

  describe("when proxy token is not configured", () => {
    beforeEach(() => start({}));

    it("returns 401 (refuses to expose anything on an open relay)", async () => {
      const res = await get();
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("proxy_token_required");
    });
  });

  describe("when proxy token is configured but client token is not", () => {
    beforeEach(() => start({ proxyToken: "proxy-secret" }));

    it("returns 401 without bearer", async () => {
      const res = await get();
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong bearer", async () => {
      const res = await get("wrong");
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("invalid_proxy_token");
    });

    it("returns 204 with correct bearer (no client token to disclose)", async () => {
      const res = await get("proxy-secret");
      expect(res.status).toBe(204);
    });
  });

  describe("when both tokens are configured", () => {
    beforeEach(() => start({ proxyToken: "proxy-secret", clientToken: "client-secret" }));

    it("returns the client token to a valid proxy bearer", async () => {
      const res = await get("proxy-secret");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { clientToken?: string };
      expect(body.clientToken).toBe("client-secret");
    });

    it("rejects an invalid bearer", async () => {
      const res = await get("nope");
      expect(res.status).toBe(401);
    });
  });
});
