import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

// 运行环境判断。tsup 打包时通过 define 把 process.env.NODE_ENV 替换为 "production"，
// IS_DEV 随之静态折叠为 false，dev 分支被 dead-code elimination 删除。
// node --import tsx 跑源码时 NODE_ENV 通常未设置，默认 "development"，IS_DEV 为 true。
const IS_DEV = (process.env.NODE_ENV ?? "development") !== "production";

interface SpawnScriptOptions extends Omit<SpawnOptions, "detached"> {
  // 默认 true。设为 false 时父进程退出会把子进程一并带走。
  unref?: boolean;
  // 传入后启用"现场记录"：子进程 stderr 按行 pipe 进 logger.warn（stderr 原文语义模糊，
  // 可能只是 deprecation warning），非零退出和 spawn 失败进 logger.error（确定性失败）。
  // 需要自己精确控制 stderr 的调用方（例如 startDaemon 要按超时展示）不要在这里传 logger，
  // 改为显式 `stdio: ["ignore", "ignore", "pipe"]` 自行挂 handler。
  logger?: Logger;
}

/**
 * 顶层 entry（serve / session-worker）在 dev 下 `src/<name>.ts`、prod 下 `dist/<name>.js`。
 * env.ts 自身：dev 在 `src/common/env.ts`，prod 被 tsup 内联进 `dist/<chunk>.js`。
 * 因此从 env.ts 看，dev 走 `../<name>`、prod 走 `./<name>` 即可命中正确目录。
 *
 * 早期 API 让调用方在自己源文件里 `new URL("./serve", import.meta.url)`，对顶层
 * caller（src/index.ts）巧合可用，但 src/terminal/、src/serve/ 这类嵌套 caller 在 src 下
 * 写 `../serve` 才对、tsup 把所有 chunk 拍平到 dist/ 根目录后又指错位置。把解析集中到
 * env.ts 这一处，调用方只传 entry 名，避免两层布局的相对路径陷阱。
 */
export function resolveTopLevelScript(name: string): URL {
  const baseDir = IS_DEV
    ? new URL("../", import.meta.url) // src/common/env.ts → src/
    : new URL("./", import.meta.url); // dist/<chunk>.js → dist/
  return new URL(name, baseDir);
}

/**
 * spawn 一个 Node 脚本作为后台 detached 子进程。
 *
 * 第一个参数支持两种形式：
 *   - 顶层 entry 名（"serve" / "session-worker"）：内部按 dev/prod 布局解析为
 *     `src/<name>.ts` 或 `dist/<name>.js`。生产代码用这种形式。
 *   - URL：fixture / 测试用，调用方自己用 `new URL("./xxx", import.meta.url)` 构造。
 *
 * helper 根据 IS_DEV 自动补扩展名并选运行时：
 *   dev: 执行 `node --import tsx <path>.ts`
 *   prod: 执行 `node <path>.js`
 *
 * @example
 *   spawnScript("serve", [], { logger: terminalLogger });
 *   spawnScript("session-worker", [sessionId, sockPath], { logger });
 */
export function spawnScript(
  script: string | URL,
  args: readonly string[] = [],
  options: SpawnScriptOptions = {},
): ChildProcess {
  const { unref = true, logger, ...rest } = options;
  // logger 传入时默认打开 stderr pipe；调用方显式传了 stdio 则尊重调用方。
  const stdio = rest.stdio ?? (logger ? ["ignore", "ignore", "pipe"] : "ignore");

  const scriptBaseUrl = typeof script === "string" ? resolveTopLevelScript(script) : script;
  const basePath = fileURLToPath(scriptBaseUrl);
  const scriptPath = `${basePath}${IS_DEV ? ".ts" : ".js"}`;
  const runtimeArgs = IS_DEV ? ["--import", "tsx", scriptPath, ...args] : [scriptPath, ...args];
  const child = spawn(process.execPath, runtimeArgs, {
    detached: true,
    ...rest,
    stdio,
  });

  if (logger) {
    if (child.stderr) {
      child.stderr.setEncoding("utf-8");
      let buf = "";
      const emit = (line: string) => {
        const trimmed = line.trim();
        if (trimmed) logger.warn({ pid: child.pid, src: "child-stderr" }, trimmed);
      };
      child.stderr.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) emit(line);
      });
      // 子进程结束时 buf 里可能还有不带 \n 的残段（比如 stderr 最后一行无换行就退出），
      // 这里 flush 一次保证捕获 100% 行内容，不被"没等到下一个 \n"吞掉。
      child.stderr.on("end", () => {
        if (buf) {
          emit(buf);
          buf = "";
        }
      });
    }
    child.once("error", (err) => {
      logger.error({ pid: child.pid, err: String(err) }, "spawn failed");
    });
    child.once("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.error({ pid: child.pid, code, signal }, "child exited abnormally");
      }
    });
  }

  if (unref) child.unref();
  return child;
}
