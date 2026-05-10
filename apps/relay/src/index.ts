import { createLogger } from "@dev-anywhere/shared";
import { createRelayServer } from "./server.js";
import { loadRelayRuntimeEnv } from "./runtime-env.js";
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

const env = loadRelayRuntimeEnv();

const logger = createLogger({
  name: "relay",
  level: env.logLevel,
  stdout: true,
});

const relay = createRelayServer({
  port: env.port,
  logger,
  dataDir: env.dataDir,
  heartbeatInterval: env.heartbeatInterval,
  proxyToken: env.proxyToken,
  clientToken: env.clientToken,
  chaos: env.chaos,
});

relay.httpServer.listen(env.port, () => {
  const addr = relay.httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : env.port;
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
