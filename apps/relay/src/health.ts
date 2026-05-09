import { Router } from "express";
import type { RelayRegistry } from "./registry.js";
import { RELAY_VERSION } from "./version.js";

// 健康检查和状态查询路由
export function healthRouter(registry: RelayRegistry): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: RELAY_VERSION,
      uptime: process.uptime(),
    });
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
