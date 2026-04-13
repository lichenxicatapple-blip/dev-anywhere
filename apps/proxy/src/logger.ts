import { mkdirSync } from "node:fs";
import pino from "pino";
import { LOG_DIR, LOG_PATH, TERMINAL_LOG_PATH } from "./paths.js";

// 确保日志目录存在，daemon 首次启动时 initWorkspace 可能还未调用
if (!process.env.VITEST) {
  mkdirSync(LOG_DIR, { recursive: true });
}

export const logger = process.env.VITEST
  ? pino({ level: "silent" })
  : pino({ level: "info" }, pino.destination(LOG_PATH));

export const terminalLogger = process.env.VITEST
  ? pino({ level: "silent" })
  : pino({ level: "debug" }, pino.destination(TERMINAL_LOG_PATH));
