import { createLogger } from "@dev-anywhere/shared";
import { LOG_DIR } from "./paths.js";

export const serviceLogger = createLogger({
  name: "service",
  logDir: LOG_DIR,
  silent: !!process.env.VITEST,
});

export const terminalLogger = createLogger({
  name: "terminal",
  level: "debug",
  logDir: LOG_DIR,
  silent: !!process.env.VITEST,
});
