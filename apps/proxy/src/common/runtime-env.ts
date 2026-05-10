// 单一入口集中读取 proxy 运行时关心的环境变量，类型化输出，避免 process.env.X
// 散落在多个文件里各自做 parseInt / 空串判断 / undefined 兜底。
//
// 范围：用户面对的运行时旋钮 + 构建/测试模式标志。
// 不包含：proxy → provider/hook 子进程之间的 plumbing（DEV_ANYWHERE_HOOK_TOKEN /
// HOOK_URL / HOOK_MARKER / HOOK_EVENT / SESSION_ID 等），这些是内部传参，不是用户旋钮，
// 留在各自消费点。

export const VALID_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;
export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

export interface ProxyRuntimeEnv {
  // RELAY_URL —— 覆盖 config.relays[name].url；用于一次性指向另一个 relay。
  relayUrl: string | undefined;
  // RELAY_PROXY_TOKEN —— 覆盖 config.relays[name].proxyToken。
  relayProxyToken: string | undefined;
  // DEV_ANYWHERE_HOOK_PORT —— 覆盖按 profile 推导的 hook server 端口。
  hookPort: number | undefined;
  // CLAUDE_BIN / CODEX_BIN —— 覆盖 config.agentCli 里的 CLI 可执行文件路径。
  claudeBin: string | undefined;
  codexBin: string | undefined;
  // LOG_LEVEL —— 用户最高优先级；config.logLevel 是次优先；都缺则各 logger 自己 default。
  logLevel: LogLevel | undefined;
  // VITEST —— 测试运行器存在则把 logger 静默，避免污染 vitest 输出。
  isVitest: boolean;
  // NODE_ENV 故意不在这里：env.ts 把它读成 top-level const 让 tsup 静态折叠 + dead-code
  // elimination dev 分支。走函数调用会破坏这个 build-time 优化。
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  if ((VALID_LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new Error(
    `Invalid LOG_LEVEL=${JSON.stringify(value)}; expected one of ${VALID_LOG_LEVELS.join(", ")}`,
  );
}

function parsePort(value: string | undefined, source: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${source}=${JSON.stringify(value)}: expected TCP port 1-65535`);
  }
  return port;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function loadProxyRuntimeEnv(env: NodeJS.ProcessEnv = process.env): ProxyRuntimeEnv {
  return {
    relayUrl: nonEmpty(env.RELAY_URL),
    relayProxyToken: nonEmpty(env.RELAY_PROXY_TOKEN),
    hookPort: parsePort(env.DEV_ANYWHERE_HOOK_PORT, "DEV_ANYWHERE_HOOK_PORT"),
    claudeBin: nonEmpty(env.CLAUDE_BIN),
    codexBin: nonEmpty(env.CODEX_BIN),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    isVitest: !!env.VITEST,
  };
}
