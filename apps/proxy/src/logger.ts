import pino from "pino";
import { LOG_PATH } from "./paths.js";

export const logger = process.env.VITEST
  ? pino({ level: "silent" })
  : pino({ level: "info" }, pino.destination(LOG_PATH));
