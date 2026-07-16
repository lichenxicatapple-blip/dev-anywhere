import fs from "node:fs";
import os from "node:os";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const BROWSER_STATE_DUMP_ENDPOINT = "/__dev_anywhere_debug/browser-state-dumps";
const BROWSER_STATE_DUMP_LIMIT_BYTES = 20 * 1024 * 1024;
const VOICE_FIXTURE_ENDPOINT = "/__dev_anywhere_debug/voice-fixture";

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
    throw new Error(
      "DEV_ANYWHERE_WEB_HTTPS_KEY and DEV_ANYWHERE_WEB_HTTPS_CERT must be set together",
    );
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

function browserStateDumpPlugin(): Plugin {
  return {
    name: "dev-anywhere-browser-state-dump",
    configureServer(server) {
      server.middlewares.use(BROWSER_STATE_DUMP_ENDPOINT, (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let closed = false;
        const reply = (status: number, body: unknown) => {
          if (closed) return;
          closed = true;
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };

        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > BROWSER_STATE_DUMP_LIMIT_BYTES) {
            reply(413, { ok: false, error: "browser state dump is too large" });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("error", (error) => {
          reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        });
        req.on("end", () => {
          if (closed) return;
          const payload = Buffer.concat(chunks).toString("utf8");
          try {
            JSON.parse(payload);
          } catch {
            reply(400, { ok: false, error: "invalid JSON payload" });
            return;
          }

          const dir =
            process.env.DEV_ANYWHERE_BROWSER_DUMP_DIR ??
            path.join(os.tmpdir(), "dev-anywhere", "browser-state-dumps");
          fs.mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const filePath = path.join(dir, `browser-state-${stamp}-${process.pid}.json`);
          fs.writeFileSync(filePath, payload);
          reply(200, { ok: true, path: filePath, bytes: Buffer.byteLength(payload) });
        });
      });
    },
  };
}

function voiceFixturePlugin(): Plugin {
  const registerMiddleware = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use(VOICE_FIXTURE_ENDPOINT, (req, res, next) => {
      if (req.method !== "GET") {
        next();
        return;
      }
      const fixturePath =
        process.env.DEV_ANYWHERE_VOICE_FIXTURE ??
        path.resolve(__dirname, "../../artifacts/voice-pilot-uat/vp_test-16k.wav");
      if (!fs.existsSync(fixturePath)) {
        res.statusCode = 404;
        res.end("Voice fixture not found");
        return;
      }
      res.statusCode = 200;
      const extension = path.extname(fixturePath).toLowerCase();
      const contentType =
        extension === ".wav"
          ? "audio/wav"
          : extension === ".m4a" || extension === ".mp4"
            ? "audio/mp4"
            : "application/octet-stream";
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "no-store");
      fs.createReadStream(fixturePath).pipe(res);
    });
  };

  return {
    name: "dev-anywhere-voice-fixture",
    configureServer: registerMiddleware,
    configurePreviewServer(server) {
      if (process.env.VITE_DEV_ANYWHERE_VOICE_FIXTURE === "1") {
        registerMiddleware(server);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    browserStateDumpPlugin(),
    voiceFixturePlugin(),
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
        background_color: "#F6F7F8",
        theme_color: "#F6F7F8",
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
        importScripts: ["notification-sw.js"],
        navigateFallback: "/index.html",
        // relay 接口不进 SPA 兜底, 避免 SW 把 WS 握手/API 错导到 index.html
        navigateFallbackDenylist: [
          /^\/proxy(\/|$|\?)/,
          /^\/client(\/|$|\?)/,
          /^\/voice(\/|$|\?)/,
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
      "/voice": {
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
      "/api": {
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
