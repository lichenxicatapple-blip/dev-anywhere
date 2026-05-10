import { createLogger } from "@dev-anywhere/shared";
import { LOG_DIR } from "./paths.js";
import { loadProxyRuntimeEnv } from "./runtime-env.js";

const env = loadProxyRuntimeEnv();

export const serviceLogger = createLogger({
  name: "service",
  logDir: LOG_DIR,
  silent: env.isVitest,
});

export const terminalLogger = createLogger({
  name: "terminal",
  level: "debug",
  logDir: LOG_DIR,
  silent: env.isVitest,
});
