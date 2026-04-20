import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";

// 运行环境判断。tsup 打包时通过 define 把 process.env.NODE_ENV 替换成 "production"，
// IS_DEV 随之静态折叠为 false，dev 分支被 dead-code elimination 删除。
// tsx 直接跑源码时 NODE_ENV 通常未设置，此处默认 "development"，IS_DEV 为 true。
export const IS_DEV = (process.env.NODE_ENV ?? "development") !== "production";

export interface SpawnBundledOptions extends Omit<SpawnOptions, "detached"> {
  // 默认 true。设为 false 可在父进程退出时让子进程一起退。
  unref?: boolean;
}

// 统一的"spawn 一个打包兄弟脚本作为 detached 子进程"辅助。
// basename: 不带扩展名的脚本名（如 "serve"、"session-worker"），
//           dev 时加 .ts 用 tsx 跑，prod 时加 .js 用 node 跑。
// scriptDir: 调用方的 __dirname（脚本和调用方在同一目录）。
export function spawnBundled(
  basename: string,
  scriptDir: string,
  args: readonly string[] = [],
  options: SpawnBundledOptions = {},
): ChildProcess {
  const { unref = true, stdio = "ignore", ...rest } = options;
  const scriptPath = join(scriptDir, IS_DEV ? `${basename}.ts` : `${basename}.js`);
  const runtime = IS_DEV ? "tsx" : process.execPath;
  const child = spawn(runtime, [scriptPath, ...args], {
    detached: true,
    stdio,
    ...rest,
  });
  if (unref) child.unref();
  return child;
}
