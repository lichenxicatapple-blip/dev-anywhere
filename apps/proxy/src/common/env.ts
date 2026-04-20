import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

// 运行环境判断。tsup 打包时通过 define 把 process.env.NODE_ENV 替换为 "production"，
// IS_DEV 随之静态折叠为 false，dev 分支被 dead-code elimination 删除。
// tsx 跑源码时 NODE_ENV 通常未设置，默认 "development"，IS_DEV 为 true。
export const IS_DEV = (process.env.NODE_ENV ?? "development") !== "production";

export interface SpawnScriptOptions extends Omit<SpawnOptions, "detached"> {
  // 默认 true。设为 false 时父进程退出会把子进程一并带走。
  unref?: boolean;
}

/**
 * spawn 一个 Node 脚本作为后台 detached 子进程。
 *
 * scriptBaseUrl 是**不带扩展名**的脚本 URL；helper 根据 IS_DEV 自动补扩展名并选运行时：
 *   dev: 执行 `tsx <path>.ts`
 *   prod: 执行 `node <path>.js`
 *
 * 调用方用 `new URL("./相对路径", import.meta.url)` 构造，不需要预先计算 __dirname。
 *
 * @example
 *   // terminal.ts 拉起 serve daemon：
 *   spawnScript(new URL("./serve", import.meta.url));
 *
 *   // serve.ts 拉起 session-worker 并传额外参数：
 *   spawnScript(new URL("./session-worker", import.meta.url), [sessionId, sockPath]);
 */
export function spawnScript(
  scriptBaseUrl: URL,
  args: readonly string[] = [],
  options: SpawnScriptOptions = {},
): ChildProcess {
  const { unref = true, stdio = "ignore", ...rest } = options;
  const basePath = fileURLToPath(scriptBaseUrl);
  const scriptPath = `${basePath}${IS_DEV ? ".ts" : ".js"}`;
  const runtime = IS_DEV ? "tsx" : process.execPath;
  const child = spawn(runtime, [scriptPath, ...args], {
    detached: true,
    stdio,
    ...rest,
  });
  if (unref) child.unref();
  return child;
}
