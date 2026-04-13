import { mkdirSync } from "node:fs";
import pino from "pino";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  logDir?: string;
  stdout?: boolean;
  silent?: boolean;
}

const DEFAULT_LOG_DIR = `${process.env.HOME}/.cc-anywhere/logs`;

export function createLogger(options: CreateLoggerOptions): pino.Logger {
  const {
    name,
    level = "info",
    logDir = DEFAULT_LOG_DIR,
    stdout = false,
    silent = false,
  } = options;

  if (silent) {
    return pino({ level: "silent" });
  }

  mkdirSync(logDir, { recursive: true });

  const filePath = `${logDir}/${name}.log`;
  const streams: pino.StreamEntry[] = [
    { stream: pino.destination(filePath) },
  ];

  if (stdout) {
    streams.unshift({ stream: process.stdout });
  }

  return pino({ level }, pino.multistream(streams));
}
