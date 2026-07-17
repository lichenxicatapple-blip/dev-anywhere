import compression from "compression";
import express, { type Express, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Logger } from "@dev-anywhere/shared/logger";

const IMMUTABLE_CACHE_SECONDS = 365 * 24 * 60 * 60;
const SHORT_CACHE_SECONDS = 60 * 60;

const RELAY_ROUTE_ROOTS = new Set([
  "/api",
  "/client",
  "/fonts",
  "/health",
  "/proxy",
  "/status",
  "/voice",
]);

function isRelayRoute(pathname: string): boolean {
  for (const root of RELAY_ROUTE_ROOTS) {
    if (pathname === root || pathname.startsWith(`${root}/`)) return true;
  }
  return false;
}

function setStaticCacheHeaders(response: Response, filePath: string): void {
  const fileName = basename(filePath);
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (normalizedPath.includes("/assets/") || /^workbox-.+\.js$/.test(fileName)) {
    response.setHeader("Cache-Control", `public, max-age=${IMMUTABLE_CACHE_SECONDS}, immutable`);
    return;
  }

  if (
    fileName === "index.html" ||
    fileName === "sw.js" ||
    fileName === "registerSW.js" ||
    fileName === "manifest.webmanifest"
  ) {
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return;
  }

  response.setHeader("Cache-Control", `public, max-age=${SHORT_CACHE_SECONDS}`);
}

export function mountWebApp(
  app: Express,
  options: {
    webAssetDir: string;
    logger: Logger;
  },
): boolean {
  const { webAssetDir, logger } = options;
  const indexPath = join(webAssetDir, "index.html");
  if (!existsSync(indexPath)) {
    logger.warn({ webAssetDir }, "Web assets not found; Relay will run without the Web UI");
    return false;
  }

  app.use(compression());
  app.use(
    express.static(webAssetDir, {
      index: false,
      fallthrough: true,
      setHeaders: setStaticCacheHeaders,
    }),
  );

  app.use((request: Request, response: Response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }

    if (isRelayRoute(request.path)) {
      response.status(404).json({ error: "not_found" });
      return;
    }

    if (!request.accepts("html")) {
      next();
      return;
    }

    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response.sendFile("index.html", { root: webAssetDir });
  });

  logger.info({ webAssetDir }, "Web UI mounted");
  return true;
}
