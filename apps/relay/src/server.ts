import express from "express";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { Logger } from "@dev-anywhere/shared/logger";
import { RelayRegistry } from "./registry.js";
import { healthRouter } from "./health.js";
import { handleProxyConnection } from "./handlers/proxy.js";
import { handleClientConnection } from "./handlers/client.js";
import { setupHeartbeat } from "./heartbeat.js";
import { createRelayChaos, type RelayChaosOptions } from "./chaos.js";
import { createVoiceConfigStore } from "./voice/config-store.js";
import { handleVoiceAsrConnection, type VoiceAsrClientFactory } from "./voice/asr-ws.js";
import { handleVoiceTtsConnection, type VoiceTtsClientFactory } from "./voice/tts-ws.js";
import { createBailianVoiceProvider } from "./voice/bailian-provider.js";
import type { VoiceCapabilitiesProvider } from "./voice/capabilities.js";
import type { VoiceConfigTester } from "./voice/config-test.js";
import { createVoiceProviderRegistry, type VoiceProviderRegistry } from "./voice/provider.js";
import { RemoteFileBridge } from "./remote-file-bridge.js";
import { mountWebApp } from "./web-app.js";

export interface RelayServerOptions {
  port?: number;
  heartbeatInterval?: number;
  logger: Logger;
  dataDir?: string;
  // proxy 注册预共享 token; 不传 / 空串则关闭鉴权 (开发默认)
  proxyToken?: string;
  // client 连接预共享 token; 不传 / 空串则关闭鉴权 (开发默认)
  clientToken?: string;
  // ws upgrade 时校验的 Origin 列表 (匹配 request.headers.origin)。空数组 / undefined 不
  // 校验, 向后兼容现有部署 (本地 dev 跨端口 / Capacitor 等)。设置后只放白名单, 阻挡
  // CSWSH——攻击者站点诱导用户浏览器直接发 ws upgrade 到 relay 时, 没有合法 Origin。
  allowedOrigins?: readonly string[];
  chaos?: RelayChaosOptions;
  fontAssetDir?: string;
  webAssetDir?: string | false;
  voiceDefaults?: {
    region?: "cn" | "intl";
    asrModel?: string;
    ttsModel?: string;
    ttsVoice?: string;
  };
  voiceAsrClientFactory?: VoiceAsrClientFactory;
  voiceTtsClientFactory?: VoiceTtsClientFactory;
  voiceCapabilitiesProvider?: VoiceCapabilitiesProvider;
  voiceConfigTester?: VoiceConfigTester;
  voiceProviderRegistry?: VoiceProviderRegistry;
}

export interface RelayServer {
  httpServer: Server;
  registry: RelayRegistry;
  close: () => Promise<void>;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGED_FONTS_DIR = resolve(MODULE_DIR, "../assets/fonts");
const PACKAGED_WEB_DIR = resolve(MODULE_DIR, "../assets/web");

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function requestRemoteAddress(request: IncomingMessage): string | undefined {
  const forwardedFor = firstHeaderValue(request.headers["x-forwarded-for"]);
  const firstForwarded = forwardedFor?.split(",")[0]?.trim();
  return firstForwarded || request.socket.remoteAddress;
}

// 创建中转服务器，Express HTTP + ws WebSocket 双端点
export function createRelayServer(options: RelayServerOptions): RelayServer {
  const { heartbeatInterval = 30000, logger, dataDir, proxyToken, clientToken, chaos } = options;
  const proxyTokenRequired = typeof proxyToken === "string" && proxyToken.length > 0;
  const clientTokenRequired = typeof clientToken === "string" && clientToken.length > 0;
  const allowedOriginsSet =
    options.allowedOrigins && options.allowedOrigins.length > 0
      ? new Set(options.allowedOrigins)
      : null;
  const checkOrigin = (origin: string | undefined): boolean => {
    if (!allowedOriginsSet) return true;
    return typeof origin === "string" && allowedOriginsSet.has(origin);
  };
  if (!proxyTokenRequired) {
    logger.warn(
      "proxy auth token not set, /proxy endpoint is open — ok for dev, not for public relay",
    );
  }
  if (!clientTokenRequired) {
    logger.warn(
      "client auth token not set, /client endpoint is open — ok for dev, not for public relay",
    );
  }

  const registry = new RelayRegistry();
  const remoteFileBridge = new RemoteFileBridge({ registry, logger });
  const voiceConfigStore = createVoiceConfigStore({
    dataDir,
    defaults: options.voiceDefaults,
  });
  const voiceProviders =
    options.voiceProviderRegistry ??
    createVoiceProviderRegistry([
      createBailianVoiceProvider({
        asrClientFactory: options.voiceAsrClientFactory,
        ttsClientFactory: options.voiceTtsClientFactory,
        capabilitiesProvider: options.voiceCapabilitiesProvider,
        configTester: options.voiceConfigTester,
      }),
    ]);
  const relayChaos = chaos?.enabled ? createRelayChaos(chaos, logger) : undefined;
  if (chaos?.enabled) {
    logger.warn(
      {
        delayMs: chaos.delayMs,
        duplicate: chaos.duplicate,
        reorder: chaos.reorder,
        types: chaos.types ? [...chaos.types] : "all",
      },
      "Relay chaos mode enabled",
    );
  }
  const app = express();
  app.disable("x-powered-by");

  // 字体优先读持久化目录；Docker 镜像再回退到随包内置字体，避免空 volume 让 Web 字体 404。
  const fontsDir = dataDir ? `${dataDir}/fonts` : `${homedir()}/.dev-anywhere/relay-data/fonts`;
  const fontAssetDir = options.fontAssetDir ?? PACKAGED_FONTS_DIR;
  app.use(
    "/fonts",
    (req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      next();
    },
    express.static(fontsDir, {
      maxAge: "30d",
      immutable: true,
    }),
  );
  if (existsSync(fontAssetDir)) {
    app.use(
      "/fonts",
      express.static(fontAssetDir, {
        maxAge: "30d",
        immutable: true,
      }),
    );
  }

  app.use(
    healthRouter(registry, {
      proxyTokenRequired,
      clientTokenRequired,
      validateClientToken: (token) => token === clientToken,
      validateProxyToken: (token) => token === proxyToken,
      getClientToken: () => clientToken ?? null,
    }),
  );
  app.get("/api/remote-files/:token", (req, res) => {
    remoteFileBridge.handleHttpRequest(req, res);
  });
  app.put("/api/remote-uploads/:token", (req, res) => {
    remoteFileBridge.handleUploadHttpRequest(req, res);
  });
  const webAssetDir =
    options.webAssetDir === false ? undefined : (options.webAssetDir ?? PACKAGED_WEB_DIR);
  if (webAssetDir) {
    mountWebApp(app, { webAssetDir, logger });
  }

  // 使用 createServer 而非 app.listen，确保 WebSocket upgrade 可在同一端口上处理
  const httpServer = createServer(app);

  const proxyWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });
  const voiceAsrWss = new WebSocketServer({ noServer: true });
  const voiceTtsWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    const origin = request.headers.origin;

    if (!checkOrigin(origin)) {
      logger.warn(
        { ip: request.socket.remoteAddress, origin: origin ?? "(missing)", pathname },
        "rejected upgrade: origin not in allowedOrigins",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pathname === "/proxy") {
      if (proxyTokenRequired) {
        const token = url.searchParams.get("token");
        if (token !== proxyToken) {
          logger.warn(
            { ip: request.socket.remoteAddress },
            "rejected /proxy upgrade: invalid token",
          );
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      proxyWss.handleUpgrade(request, socket, head, (ws) => {
        proxyWss.emit("connection", ws, request);
      });
      return;
    }

    if (pathname === "/client" || pathname === "/voice/asr" || pathname === "/voice/tts") {
      if (clientTokenRequired) {
        const token = url.searchParams.get("token");
        if (token !== clientToken) {
          logger.warn(
            { ip: request.socket.remoteAddress, pathname },
            "rejected client-side upgrade: invalid token",
          );
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      if (pathname === "/client") {
        clientWss.handleUpgrade(request, socket, head, (ws) => {
          clientWss.emit("connection", ws, request);
        });
      } else if (pathname === "/voice/asr") {
        voiceAsrWss.handleUpgrade(request, socket, head, (ws) => {
          voiceAsrWss.emit("connection", ws, request);
        });
      } else {
        voiceTtsWss.handleUpgrade(request, socket, head, (ws) => {
          voiceTtsWss.emit("connection", ws, request);
        });
      }
      return;
    }

    socket.destroy();
  });

  proxyWss.on("connection", (ws) => {
    handleProxyConnection(ws, registry, logger, relayChaos, remoteFileBridge);
  });

  clientWss.on("connection", (ws, request) => {
    handleClientConnection(
      ws,
      registry,
      logger,
      relayChaos,
      voiceConfigStore,
      voiceProviders,
      remoteFileBridge,
      {
        userAgent: firstHeaderValue(request.headers["user-agent"]),
        remoteAddress: requestRemoteAddress(request),
      },
    );
  });

  voiceAsrWss.on("connection", (ws) => {
    handleVoiceAsrConnection(ws, voiceConfigStore, logger, voiceProviders);
  });

  voiceTtsWss.on("connection", (ws) => {
    handleVoiceTtsConnection(ws, voiceConfigStore, logger, voiceProviders);
  });

  const proxyHeartbeat = setupHeartbeat(proxyWss, heartbeatInterval, {
    logger,
    peerType: "proxy",
    describePeer: (ws) => ({ proxyId: (ws as { proxyId?: string }).proxyId }),
  });
  const clientHeartbeat = setupHeartbeat(clientWss, heartbeatInterval, {
    logger,
    peerType: "client",
    describePeer: (ws) => ({
      clientId: (ws as { clientId?: string }).clientId,
      boundProxyId: (ws as { boundProxyId?: string }).boundProxyId,
    }),
  });
  const voiceAsrHeartbeat = setupHeartbeat(voiceAsrWss, heartbeatInterval, {
    logger,
    peerType: "voice-asr",
  });
  const voiceTtsHeartbeat = setupHeartbeat(voiceTtsWss, heartbeatInterval, {
    logger,
    peerType: "voice-tts",
  });

  async function close(): Promise<void> {
    clearInterval(proxyHeartbeat);
    clearInterval(clientHeartbeat);
    clearInterval(voiceAsrHeartbeat);
    clearInterval(voiceTtsHeartbeat);

    for (const ws of proxyWss.clients) {
      ws.terminate();
    }
    for (const ws of clientWss.clients) {
      ws.terminate();
    }
    for (const ws of voiceAsrWss.clients) {
      ws.terminate();
    }
    for (const ws of voiceTtsWss.clients) {
      ws.terminate();
    }

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        proxyWss.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        clientWss.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        voiceAsrWss.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        voiceTtsWss.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    ]);

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { httpServer, registry, close };
}
