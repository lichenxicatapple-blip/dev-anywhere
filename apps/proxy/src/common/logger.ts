import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "@dev-anywhere/shared";
import { CONFIG_PATH, LOG_DIR } from "./paths.js";
import { loadProxyRuntimeEnv, VALID_LOG_LEVELS } from "./runtime-env.js";

const env = loadProxyRuntimeEnv();

// 直接读 config.json 而不走 config.ts loadConfig：loadConfig 依赖 logger.ts，
// 反向引用会形成循环。这里只取 logLevel 字段做 best-effort 降级，全量 schema 校验仍由
// config.ts 在第一次 loadConfig 时执行。
function readConfigLogLevel(): string | undefined {
  if (env.logLevel) return undefined;
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { logLevel?: unknown };
    if (typeof raw.logLevel !== "string") return undefined;
    return (VALID_LOG_LEVELS as readonly string[]).includes(raw.logLevel) ? raw.logLevel : undefined;
  } catch {
    return undefined;
  }
}

// 三级 precedence：LOG_LEVEL env > config.logLevel > 各 logger 自己的默认。
const overrideLevel = env.logLevel ?? readConfigLogLevel();

export const serviceLogger = createLogger({
  name: "service",
  level: overrideLevel ?? "info",
  logDir: LOG_DIR,
  silent: env.isVitest,
});

export const terminalLogger = createLogger({
  name: "terminal",
  level: overrideLevel ?? "debug",
  logDir: LOG_DIR,
  silent: env.isVitest,
});
