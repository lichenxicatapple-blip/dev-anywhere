// Relay 运行时环境变量的单一入口。和 proxy 侧 runtime-env.ts 同一思路：
// 类型化输出 + 一次性校验，避免 parseInt / 默认值散落在 index.ts 和 chaos.ts。
import { homedir } from "node:os";
import { parseRelayChaosFromEnv, type RelayChaosOptions } from "./chaos.js";

const DEFAULT_DATA_DIR = `${homedir()}/.dev-anywhere/relay-data`;
const DEFAULT_PORT = 3100;
const DEFAULT_HEARTBEAT_INTERVAL = 30000;

interface RelayRuntimeEnv {
  port: number;
  // DATA_DIR 显式置 "" 表示关闭持久化目录；未设置时回落到 ~/.dev-anywhere/relay-data。
  dataDir: string | undefined;
  heartbeatInterval: number;
  // 任一 token 未设置（或空串）→ 对应端点关闭鉴权（仅 dev 可用）。
  proxyToken: string | undefined;
  clientToken: string | undefined;
  // ALLOWED_ORIGINS=https://app.example.com,https://www.example.com — 逗号分隔。
  // 空 / 未设置 = 不校验 (向后兼容; 本地 dev / Capacitor / file:// 等场景需要)。
  // 公网部署务必设置, 防 CSWSH。
  allowedOrigins: string[];
  logLevel: string;
  chaos: RelayChaosOptions;
  voiceDefaults: {
    region?: "cn" | "intl";
    asrModel?: string;
    ttsModel?: string;
    ttsVoice?: string;
  };
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

function parseVoiceRegion(value: string | undefined): "cn" | "intl" | undefined {
  if (!value) return undefined;
  if (value === "cn" || value === "intl") return value;
  throw new Error(`Invalid BAILIAN_REGION=${JSON.stringify(value)}: expected cn or intl`);
}

export function loadRelayRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RelayRuntimeEnv {
  const dataDirRaw = env.DATA_DIR ?? DEFAULT_DATA_DIR;
  const voiceRegion = parseVoiceRegion(env.BAILIAN_REGION);
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
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    logLevel: env.LOG_LEVEL ?? "info",
    chaos: parseRelayChaosFromEnv(env),
    voiceDefaults: {
      ...(voiceRegion ? { region: voiceRegion } : {}),
      ...(nonEmpty(env.BAILIAN_ASR_MODEL) ? { asrModel: env.BAILIAN_ASR_MODEL } : {}),
      ...(nonEmpty(env.BAILIAN_TTS_MODEL) ? { ttsModel: env.BAILIAN_TTS_MODEL } : {}),
      ...(nonEmpty(env.BAILIAN_TTS_VOICE) ? { ttsVoice: env.BAILIAN_TTS_VOICE } : {}),
    },
  };
}
