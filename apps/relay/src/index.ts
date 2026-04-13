import { mkdirSync } from "node:fs";
import pino from "pino";
import { createRelayServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const DEFAULT_DATA_DIR = `${process.env.HOME}/.cc-anywhere/relay-data`;
// ?? 而不是 ||：空字符串表示显式禁用持久化，undefined 表示使用默认路径
const DATA_DIR = (process.env.DATA_DIR ?? DEFAULT_DATA_DIR) || undefined;
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL ?? "30000", 10);

const LOG_DIR = `${process.env.HOME}/.cc-anywhere/logs`;
const LOG_FILE = `${LOG_DIR}/relay.log`;

let logger: pino.Logger;
if (process.env.NODE_ENV === "production") {
  // 容器环境：stdout only，容器编排工具负责日志收集
  logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
} else {
  // 开发环境：同时写 stdout 和文件，方便本地调试
  mkdirSync(LOG_DIR, { recursive: true });
  logger = pino(
    { level: process.env.LOG_LEVEL ?? "info" },
    pino.multistream([
      { stream: process.stdout },
      { stream: pino.destination(LOG_FILE) },
    ]),
  );
}

const relay = createRelayServer({ port: PORT, logger, dataDir: DATA_DIR, heartbeatInterval: HEARTBEAT_INTERVAL });

relay.httpServer.listen(PORT, () => {
  const addr = relay.httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  logger.info({ port: actualPort }, "Relay server started");
});

async function shutdown(): Promise<void> {
  logger.info("Shutting down relay server");
  await relay.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdown();
});
process.on("SIGINT", () => {
  shutdown();
});
