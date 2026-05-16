import fs from "node:fs";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

function normalizeRelayTarget(target: string | undefined): { http: string; ws: string } {
  const raw = (target || "http://localhost:3100").trim().replace(/\/$/, "");
  return {
    http: raw.replace(/^ws:/, "http:").replace(/^wss:/, "https:"),
    ws: raw.replace(/^http:/, "ws:").replace(/^https:/, "wss:"),
  };
}

const relayTarget = normalizeRelayTarget(process.env.DEV_ANYWHERE_WEB_RELAY_TARGET);

function loadHttpsConfig() {
  const keyPath = process.env.DEV_ANYWHERE_WEB_HTTPS_KEY;
  const certPath = process.env.DEV_ANYWHERE_WEB_HTTPS_CERT;
  if (!keyPath && !certPath) return undefined;
  if (!keyPath || !certPath) {
    throw new Error("DEV_ANYWHERE_WEB_HTTPS_KEY and DEV_ANYWHERE_WEB_HTTPS_CERT must be set together");
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["brand-icon.svg"],
      manifest: {
        name: "DEV Anywhere",
        short_name: "DEV Anywhere",
        description: "本地 AI CLI 透明代理和远程镜像: 在浏览器中实时查看和接管本地开发会话",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#1E1E1E",
        theme_color: "#1E1E1E",
        lang: "zh-CN",
        categories: ["developer", "productivity"],
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // relay 接口不进 SPA 兜底, 避免 SW 把 WS 握手/API 错导到 index.html
        navigateFallbackDenylist: [
          /^\/proxy(\/|$|\?)/,
          /^\/client(\/|$|\?)/,
          /^\/fonts\//,
          /^\/health/,
          /^\/status/,
          /^\/api\//,
        ],
        // 字体走 runtime cache: 体积大, 变更少, 不预缓存免占包
        runtimeCaching: [
          {
            urlPattern: /^\/fonts\/.*\.(woff2|woff|ttf|otf|css)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "dev-anywhere-fonts",
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 180 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    https: loadHttpsConfig(),
    port: 5173,
    proxy: {
      "/client": {
        target: relayTarget.ws,
        ws: true,
        changeOrigin: true,
      },
      "/proxy": {
        target: relayTarget.ws,
        ws: true,
        changeOrigin: true,
      },
      "/fonts": {
        target: relayTarget.http,
        changeOrigin: true,
      },
      "/health": {
        target: relayTarget.http,
        changeOrigin: true,
      },
      "/auth": {
        target: relayTarget.http,
        changeOrigin: true,
      },
    },
  },
});
