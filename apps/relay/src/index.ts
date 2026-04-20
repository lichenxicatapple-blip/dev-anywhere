import { homedir } from "node:os";
import { createLogger } from "@cc-anywhere/shared";
import { createRelayServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const DEFAULT_DATA_DIR = `${homedir()}/.cc-anywhere/relay-data`;
// ?? 而不是 ||：空字符串表示显式禁用持久化，undefined 表示使用默认路径
const DATA_DIR = (process.env.DATA_DIR ?? DEFAULT_DATA_DIR) || undefined;
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL ?? "30000", 10);
const PROXY_TOKEN = process.env.RELAY_PROXY_TOKEN;

const logger = createLogger({
  name: "relay",
  level: process.env.LOG_LEVEL ?? "info",
  stdout: true,
});

const relay = createRelayServer({
  port: PORT,
  logger,
  dataDir: DATA_DIR,
  heartbeatInterval: HEARTBEAT_INTERVAL,
  proxyToken: PROXY_TOKEN,
});

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
