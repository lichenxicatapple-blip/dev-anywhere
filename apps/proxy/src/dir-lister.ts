import { readdirSync } from "node:fs";
import { sep } from "node:path";

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export const WATCH_BLACKLIST = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", ".tox", "target", ".gradle",
]);

/**
 * 检查路径中是否包含黑名单目录
 */
export function isBlacklistedPath(filePath: string): boolean {
  const segments = filePath.split(sep === "\\" ? /[\\/]/ : "/");
  return segments.some((segment) => WATCH_BLACKLIST.has(segment));
}

/**
 * 列出目录内容，返回排序后的条目列表
 *
 * 排序规则：目录在前，文件在后，各自按字母序
 * 黑名单目录会被过滤掉
 * 路径不存在或无权限时返回空数组
 */
export function listDirectory(dirPath: string): DirEntry[] {
  let dirents: ReturnType<typeof readdirSync>;
  try {
    dirents = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: DirEntry[] = [];
  const files: DirEntry[] = [];

  for (const dirent of dirents) {
    if (WATCH_BLACKLIST.has(dirent.name)) continue;

    if (dirent.isDirectory()) {
      dirs.push({ name: dirent.name, isDir: true });
    } else {
      files.push({ name: dirent.name, isDir: false });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files];
}
