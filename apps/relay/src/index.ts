import pino from "pino";
import { createRelayServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const DATA_DIR = process.env.DATA_DIR || undefined;
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL ?? "30000", 10);
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

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
