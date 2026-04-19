import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["brand-icon.svg"],
      manifest: {
        name: "CC Anywhere",
        short_name: "CC Anywhere",
        description: "Claude Code 远程控制: 手机浏览器像坐在电脑前一样实时与 Claude Code 交互",
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
              cacheName: "cc-fonts",
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
    port: 5173,
    proxy: {
      "/client": {
        target: "ws://localhost:3100",
        ws: true,
      },
      "/proxy": {
        target: "ws://localhost:3100",
        ws: true,
      },
      "/fonts": {
        target: "http://localhost:3100",
      },
      "/health": {
        target: "http://localhost:3100",
      },
    },
  },
});
