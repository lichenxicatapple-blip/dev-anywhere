import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import pino from "pino";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  logDir?: string;
  retention?: number;
  stdout?: boolean;
  silent?: boolean;
}

const DEFAULT_LOG_DIR = `${homedir()}/.dev-anywhere/logs`;
const DEFAULT_LOG_RETENTION = 50;

const PROCESS_LOG_RUN_ID = sanitizeRunId(
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function linkLatestLog(logDir: string, name: string, filePath: string, runId: string): void {
  const latestPath = join(logDir, `${name}.log`);

  try {
    const stat = lstatSync(latestPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(latestPath);
    } else {
      renameSync(latestPath, join(logDir, `${name}-legacy-${runId}.log`));
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return;
  }

  try {
    symlinkSync(basename(filePath), latestPath);
  } catch {
    // 日志本体仍然写入 run-specific 文件；latest 链接失败不应阻塞服务启动。
  }
}

function resolveRetention(retention: number | undefined): number {
  if (retention === undefined) return DEFAULT_LOG_RETENTION;
  return Number.isFinite(retention) && retention >= 0
    ? Math.floor(retention)
    : DEFAULT_LOG_RETENTION;
}

function pruneOldLogs(
  logDir: string,
  name: string,
  currentFilePath: string,
  retention: number | undefined,
): void {
  const keep = resolveRetention(retention);
  if (keep === 0) return;

  const currentFileName = basename(currentFilePath);
  const prefix = `${name}-`;
  const candidates = readdirSync(logDir)
    .filter(
      (entry) => entry.startsWith(prefix) && entry.endsWith(".log") && entry !== currentFileName,
    )
    .map((entry) => {
      const path = join(logDir, entry);
      try {
        return { path, mtimeMs: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const stale of candidates.slice(Math.max(0, keep - 1))) {
    try {
      unlinkSync(stale.path);
    } catch {
      // 日志清理失败不能影响主进程启动。
    }
  }
}

function buildPinoLogger(options: CreateLoggerOptions): pino.Logger {
  const {
    name,
    level = "info",
    logDir = DEFAULT_LOG_DIR,
    retention,
    stdout = false,
    silent = false,
  } = options;

  if (silent) {
    return pino({ level: "silent" });
  }

  mkdirSync(logDir, { recursive: true });

  const runId = PROCESS_LOG_RUN_ID;
  const filePath = join(logDir, `${name}-${runId}.log`);
  linkLatestLog(logDir, name, filePath, runId);
  pruneOldLogs(logDir, name, filePath, retention);
  const streams: pino.StreamEntry[] = [{ stream: pino.destination(filePath) }];

  if (stdout) {
    streams.unshift({ stream: process.stdout });
  }

  return pino({ level }, pino.multistream(streams));
}

// 返回一个 lazy proxy：调用 createLogger 本身不触发 mkdirSync / pino.destination
// 等任何文件 IO，只有第一次实际访问 logger 的方法/属性时才构造底层 pino Logger。
// 这样 `dev-anywhere -v` / `dev-anywhere init` 等不需要写日志的命令路径不会
// 落地空 log 文件，也避免异步 SonicBoom 在 process.exit 时未 ready 的 race。
export function createLogger(options: CreateLoggerOptions): pino.Logger {
  let real: pino.Logger | null = null;
  const ensure = (): pino.Logger => {
    if (!real) real = buildPinoLogger(options);
    return real;
  };

  return new Proxy(Object.create(null) as pino.Logger, {
    get(_target, prop) {
      const target = ensure();
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(ensure(), prop, value);
    },
    has(_target, prop) {
      return Reflect.has(ensure(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(ensure());
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(ensure(), prop);
    },
  });
}
