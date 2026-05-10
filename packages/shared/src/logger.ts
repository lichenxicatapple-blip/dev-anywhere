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
  // 同步落盘：sonic-boom 默认异步 open + 异步 write，测试里需要在断言前看到文件，
  // 或在 afterEach 删目录前确保后台 worker 已经退出，必须开同步。生产保留异步以避免热路径阻塞。
  sync?: boolean;
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

// SonicBoom 实例的最小结构契约（pino.destination 返回它，但 pino 类型只暴露 DestinationStream
// 接口，没有 fd / flushSync / once，所以这里手写一个结构类型用于 flushLogger）。
interface SonicLikeDestination {
  fd?: number;
  flushSync?: () => void;
  once?: (event: string, cb: (...args: unknown[]) => void) => void;
}

interface LoggerMeta {
  materialized: boolean;
  destination: SonicLikeDestination | null;
}

const loggerMetaMap = new WeakMap<pino.Logger, LoggerMeta>();

function buildPinoLogger(options: CreateLoggerOptions): {
  logger: pino.Logger;
  destination: SonicLikeDestination | null;
} {
  const {
    name,
    level = "info",
    logDir = DEFAULT_LOG_DIR,
    retention,
    stdout = false,
    silent = false,
    sync = false,
  } = options;

  if (silent) {
    return { logger: pino({ level: "silent" }), destination: null };
  }

  mkdirSync(logDir, { recursive: true });

  const runId = PROCESS_LOG_RUN_ID;
  const filePath = join(logDir, `${name}-${runId}.log`);
  linkLatestLog(logDir, name, filePath, runId);
  pruneOldLogs(logDir, name, filePath, retention);
  const destination = pino.destination({ dest: filePath, sync }) as unknown as SonicLikeDestination;
  const streams: pino.StreamEntry[] = [{ stream: destination as pino.DestinationStream }];

  if (stdout) {
    streams.unshift({ stream: process.stdout });
  }

  return { logger: pino({ level }, pino.multistream(streams)), destination };
}

// 返回一个 lazy proxy：调用 createLogger 本身不触发 mkdirSync / pino.destination
// 等任何文件 IO，只有第一次实际访问 logger 的方法/属性时才构造底层 pino Logger。
// 这样 `dev-anywhere -v` / `dev-anywhere init` 等不需要写日志的命令路径不会
// 落地空 log 文件，也避免异步 SonicBoom 在 process.exit 时未 ready 的 race。
export function createLogger(options: CreateLoggerOptions): pino.Logger {
  let real: pino.Logger | null = null;
  const meta: LoggerMeta = { materialized: false, destination: null };
  const ensure = (): pino.Logger => {
    if (!real) {
      const built = buildPinoLogger(options);
      real = built.logger;
      meta.materialized = true;
      meta.destination = built.destination;
    }
    return real;
  };

  const proxy = new Proxy(Object.create(null) as pino.Logger, {
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

  loggerMetaMap.set(proxy, meta);
  return proxy;
}

// 进程退出前等 sonic-boom 真正落盘。`pino.flush(cb)` 在 destination 还没 ready
// （fs.open 异步未完成）时会立刻回调 err=undefined 撒谎成功，但文件还是空的，所以
// 这里直接走 sonic-boom 的 ready 事件 + flushSync 路径。
//   - 未实例化（lazy proxy 没被访问过） → no-op，不会触发文件 IO 副作用。
//   - silent / stdout-only（destination 为 null） → no-op。
//   - timeoutMs 是兜底，确保异常情况下不会卡住进程退出。
export async function flushLogger(logger: pino.Logger, timeoutMs = 200): Promise<void> {
  const meta = loggerMetaMap.get(logger);
  if (!meta || !meta.materialized) return;
  const dest = meta.destination;
  if (!dest) return;

  if (dest.fd == null || dest.fd < 0) {
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      dest.once?.("ready", () => {
        clearTimeout(timer);
        resolve(true);
      });
      dest.once?.("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!opened) return;
  }

  try {
    dest.flushSync?.();
  } catch {
    // 文件描述符已关闭、磁盘满等极端情况下吞掉异常，避免把退出路径变成崩溃路径。
  }
}
