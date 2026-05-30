import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { createLogger } from "@dev-anywhere/shared/logger";
import { getPort } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

// /api/status, /api/proxies, /api/clients 暴露拓扑/绑定信息。proxyToken 配置后必须 Bearer 校验，
// 否则任何外部请求都能枚举 relay 上挂着哪些 proxy 与 client，是公网部署的真实风险面。
describe("/api/status, /api/proxies, /api/clients auth", () => {
  let relay: RelayServer;
  let port: number;

  async function start(opts: { proxyToken?: string }): Promise<void> {
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

  async function get(path: string, token?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    return await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  }

  afterEach(async () => {
    await relay.close();
  });

  describe("dev mode (proxyToken not configured)", () => {
    beforeEach(() => start({}));

    it("公开放行 status/proxies/clients", async () => {
      for (const path of ["/api/status", "/api/proxies", "/api/clients"]) {
        const res = await get(path);
        expect(res.status, path).toBe(200);
      }
    });
  });

  describe("public-relay mode (proxyToken configured)", () => {
    beforeEach(() => start({ proxyToken: "proxy-secret" }));

    it("无 token 时拒绝 status/proxies/clients", async () => {
      for (const path of ["/api/status", "/api/proxies", "/api/clients"]) {
        const res = await get(path);
        expect(res.status, path).toBe(401);
        const body = (await res.json()) as { error?: string };
        expect(body.error, path).toBe("invalid_proxy_token");
      }
    });

    it("错误 token 时拒绝 status/proxies/clients", async () => {
      for (const path of ["/api/status", "/api/proxies", "/api/clients"]) {
        const res = await get(path, "wrong");
        expect(res.status, path).toBe(401);
      }
    });

    it("正确 token 时允许 status/proxies/clients", async () => {
      for (const path of ["/api/status", "/api/proxies", "/api/clients"]) {
        const res = await get(path, "proxy-secret");
        expect(res.status, path).toBe(200);
      }
    });
  });
});
