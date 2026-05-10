import { Router } from "express";
import type { RelayRegistry } from "./registry.js";
import { RELAY_VERSION } from "./version.js";

interface HealthRouterOptions {
  proxyTokenRequired?: boolean;
  clientTokenRequired?: boolean;
  validateClientToken?: (token: string | null) => boolean;
  validateProxyToken?: (token: string | null) => boolean;
  // proxyToken 验证通过且 client token 已配置时返回当前值；否则返回 null。
  getClientToken?: () => string | null;
}

function bearerToken(authHeader: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  return match?.[1] ?? null;
}

// 健康检查和状态查询路由
export function healthRouter(registry: RelayRegistry, options: HealthRouterOptions = {}): Router {
  const router = Router();
  const proxyTokenRequired = options.proxyTokenRequired ?? false;
  const clientTokenRequired = options.clientTokenRequired ?? false;

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: RELAY_VERSION,
      uptime: process.uptime(),
      auth: {
        proxyTokenRequired,
        clientTokenRequired,
      },
    });
  });

  router.get("/auth/client", (req, res) => {
    if (!clientTokenRequired) {
      res.status(204).end();
      return;
    }
    const token = bearerToken(req.get("authorization"));
    if (options.validateClientToken?.(token)) {
      res.status(204).end();
      return;
    }
    res.status(401).json({ error: "invalid_client_token" });
  });

  // 已认证 proxy（凭 proxyToken）查询当前生效的 client token，避免运维者必须 ssh 上来读 .env。
  // 行为：proxy token 关闭时直接 401（防止开放 relay 公开 token）；proxy token 不匹配 401；
  // 校验通过且 client token 已配置返回 { clientToken }；client token 未配置返回 204。
  router.get("/admin/client-token", (req, res) => {
    if (!proxyTokenRequired) {
      res.status(401).json({ error: "proxy_token_required" });
      return;
    }
    const token = bearerToken(req.get("authorization"));
    if (!options.validateProxyToken?.(token)) {
      res.status(401).json({ error: "invalid_proxy_token" });
      return;
    }
    const clientToken = options.getClientToken?.() ?? null;
    if (!clientToken) {
      res.status(204).end();
      return;
    }
    res.json({ clientToken });
  });

  router.get("/status", (_req, res) => {
    res.json({
      version: RELAY_VERSION,
      proxyCount: registry.listProxies().length,
      clientCount: registry.countClients(),
      uptime: process.uptime(),
    });
  });

  // 连接总览：proxy/client 计数、绑定关系
  router.get("/api/status", (_req, res) => {
    res.json({
      version: RELAY_VERSION,
      proxyCount: registry.listProxies().length,
      clientCount: registry.countClients(),
      uptime: process.uptime(),
      bindings: registry.getClientDetails(),
    });
  });

  // 逐 proxy 详情：id、名称、在线状态、会话列表、离线时间
  router.get("/api/proxies", (_req, res) => {
    const proxyIds = registry.listProxies();
    const details = proxyIds
      .map((id) => registry.getProxyDetail(id))
      .filter((d) => d !== undefined);
    res.json(details);
  });

  // 逐客户端详情：clientId、绑定的 proxyId、在线状态
  router.get("/api/clients", (_req, res) => {
    res.json(registry.getClientDetails());
  });

  return router;
}
