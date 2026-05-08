import { homedir } from "node:os";
import { createLogger } from "@dev-anywhere/shared";
import { createRelayServer } from "./server.js";
import { parseRelayChaosFromEnv } from "./chaos.js";
import { RELAY_VERSION } from "./version.js";

function printHelp(): void {
  console.log(`DEV Anywhere Relay

Usage:
  dev-anywhere-relay [options]

Options:
  -h, --help       Show this help message
  -v, --version    Print version

Environment:
  PORT                 HTTP/WebSocket listen port (default: 3100)
  RELAY_PROXY_TOKEN    Optional token for /proxy connections
  RELAY_CLIENT_TOKEN   Optional token for /client connections
  DATA_DIR             Relay persistence directory; empty disables persistence
  LOG_LEVEL            Log level (default: info)
  HEARTBEAT_INTERVAL   Proxy/client heartbeat interval in ms (default: 30000)
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(RELAY_VERSION);
  process.exit(0);
}

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const DEFAULT_DATA_DIR = `${homedir()}/.dev-anywhere/relay-data`;
// DATA_DIR="" 表示显式禁用默认数据目录。
const DATA_DIR = (process.env.DATA_DIR ?? DEFAULT_DATA_DIR) || undefined;
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL ?? "30000", 10);
const PROXY_TOKEN = process.env.RELAY_PROXY_TOKEN;
const CLIENT_TOKEN = process.env.RELAY_CLIENT_TOKEN;

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
  clientToken: CLIENT_TOKEN,
  chaos: parseRelayChaosFromEnv(process.env),
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
