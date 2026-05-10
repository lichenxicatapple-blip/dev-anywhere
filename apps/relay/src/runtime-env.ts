// Relay 运行时环境变量的单一入口。和 proxy 侧 runtime-env.ts 同一思路：
// 类型化输出 + 一次性校验，避免 parseInt / 默认值散落在 index.ts 和 chaos.ts。
import { homedir } from "node:os";
import { parseRelayChaosFromEnv, type RelayChaosOptions } from "./chaos.js";

const DEFAULT_DATA_DIR = `${homedir()}/.dev-anywhere/relay-data`;
const DEFAULT_PORT = 3100;
const DEFAULT_HEARTBEAT_INTERVAL = 30000;

export interface RelayRuntimeEnv {
  port: number;
  // DATA_DIR 显式置 "" 表示关闭持久化目录；未设置时回落到 ~/.dev-anywhere/relay-data。
  dataDir: string | undefined;
  heartbeatInterval: number;
  // 任一 token 未设置（或空串）→ 对应端点关闭鉴权（仅 dev 可用）。
  proxyToken: string | undefined;
  clientToken: string | undefined;
  logLevel: string;
  chaos: RelayChaosOptions;
}

function parsePort(value: string | undefined, fallback: number, source: string): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${source}=${JSON.stringify(value)}: expected TCP port 1-65535`);
  }
  return port;
}

function parsePositiveInt(value: string | undefined, fallback: number, source: string): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${source}=${JSON.stringify(value)}: expected positive integer`);
  }
  return n;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function loadRelayRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RelayRuntimeEnv {
  const dataDirRaw = env.DATA_DIR ?? DEFAULT_DATA_DIR;
  return {
    port: parsePort(env.PORT, DEFAULT_PORT, "PORT"),
    dataDir: dataDirRaw.length > 0 ? dataDirRaw : undefined,
    heartbeatInterval: parsePositiveInt(
      env.HEARTBEAT_INTERVAL,
      DEFAULT_HEARTBEAT_INTERVAL,
      "HEARTBEAT_INTERVAL",
    ),
    proxyToken: nonEmpty(env.RELAY_PROXY_TOKEN),
    clientToken: nonEmpty(env.RELAY_CLIENT_TOKEN),
    logLevel: env.LOG_LEVEL ?? "info",
    chaos: parseRelayChaosFromEnv(env),
  };
}
