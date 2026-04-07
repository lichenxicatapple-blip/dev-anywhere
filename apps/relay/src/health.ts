import { Router } from "express";
import type { RelayRegistry } from "./registry.js";

// 健康检查和状态查询路由
export function healthRouter(registry: RelayRegistry): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
    });
  });

  router.get("/status", (_req, res) => {
    const bufferStats = registry.getBufferStats();
    res.json({
      proxyCount: registry.listProxies().length,
      clientCount: registry.countClients(),
      uptime: process.uptime(),
      buffers: bufferStats,
    });
  });

  return router;
}
