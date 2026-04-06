import pino from "pino";
import { createRelayServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const relay = createRelayServer({ port: PORT, logger });

relay.httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, "Relay server started");
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
