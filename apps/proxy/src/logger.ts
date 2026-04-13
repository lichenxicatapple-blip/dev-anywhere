import pino from "pino";
import { LOG_PATH, TERMINAL_LOG_PATH } from "./paths.js";

export const logger = process.env.VITEST
  ? pino({ level: "silent" })
  : pino({ level: "info" }, pino.destination(LOG_PATH));

export const terminalLogger = process.env.VITEST
  ? pino({ level: "silent" })
  : pino({ level: "debug" }, pino.destination(TERMINAL_LOG_PATH));
