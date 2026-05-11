import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 写 tmp + rename 替代直接 writeFileSync, 避免进程在写中途崩溃留下截断/部分写入的文件——
// 下次启动 readFileSync + JSON.parse 会抛 daemon 起不来。rename 在同 fs 内是原子操作。
//
// mode 可选: 默认沿用 fs 默认 (通常 0o644); 持久化含敏感字段 (token / 凭据) 时务必传 0o600。
export function atomicWriteFileSync(
  filePath: string,
  data: string | Buffer,
  options: { mode?: number; ensureDir?: boolean } = {},
): void {
  if (options.ensureDir) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, data, { mode: options.mode });
  renameSync(tmpPath, filePath);
}
