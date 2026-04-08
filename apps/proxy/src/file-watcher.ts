import { watch, type FSWatcher } from "node:fs";
import { join, dirname, sep } from "node:path";
import { listDirectory, isBlacklistedPath, WATCH_BLACKLIST, type DirEntry } from "./dir-lister.js";

/**
 * 文件系统监控器，使用 lazy expansion 策略
 *
 * 初始只监控工作目录前 2 层，用户通过 file picker 浏览更深目录时
 * 才扩展监控范围。macOS 上使用 FSEvents，可靠性高无需 fallback。
 *
 * 变化事件按目录维度 throttle，避免高频 I/O 操作。
 */
export class FileWatcher {
  private watchers = new Map<string, FSWatcher>();
  private throttleTimers = new Map<string, NodeJS.Timeout>();
  private readonly workDir: string;
  private readonly onUpdate: (dirPath: string, entries: DirEntry[]) => void;
  private readonly throttleMs: number;

  constructor(
    workDir: string,
    onUpdate: (dirPath: string, entries: DirEntry[]) => void,
    throttleMs = 2000,
  ) {
    this.workDir = workDir;
    this.onUpdate = onUpdate;
    this.throttleMs = throttleMs;
  }

  /**
   * 启动文件监控，使用 fs.watch recursive 模式
   *
   * macOS 的 FSEvents 支持 recursive，单个 watcher 即可覆盖整棵树。
   * 黑名单目录中的变化事件会被忽略。
   */
  start(): void {
    try {
      const watcher = watch(this.workDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;

        // 检查路径中是否包含黑名单目录
        if (isBlacklistedPath(filename)) return;

        const fullPath = join(this.workDir, filename);
        const dirPath = this.resolveDirectory(fullPath, filename);

        this.scheduleUpdate(dirPath);
      });

      this.watchers.set(this.workDir, watcher);
    } catch {
      // 目录不存在或无权限
    }
  }

  /**
   * 根据变化文件推断其所在目录
   */
  private resolveDirectory(fullPath: string, filename: string): string {
    // filename 可能是文件或目录本身
    // 对于文件变化事件，取其父目录
    // 无法 stat 时退回到 dirname
    try {
      return dirname(fullPath);
    } catch {
      return join(this.workDir, dirname(filename));
    }
  }

  /**
   * 按目录维度 throttle 更新事件
   *
   * 同一目录在 throttleMs 内的多次变化只触发一次回调
   */
  private scheduleUpdate(dirPath: string): void {
    if (this.throttleTimers.has(dirPath)) return;

    const timer = setTimeout(() => {
      this.throttleTimers.delete(dirPath);
      const entries = listDirectory(dirPath);
      this.onUpdate(dirPath, entries);
    }, this.throttleMs);

    this.throttleTimers.set(dirPath, timer);
  }

  /**
   * 获取初始目录树，仅展开到指定深度
   *
   * 用于首次连接时推送给客户端的目录结构
   */
  getInitialTree(depth = 2): Map<string, DirEntry[]> {
    const tree = new Map<string, DirEntry[]>();
    this.walkTree(this.workDir, 0, depth, tree);
    return tree;
  }

  /**
   * 递归遍历目录树，收集各层级的条目列表
   */
  private walkTree(
    dirPath: string,
    currentDepth: number,
    maxDepth: number,
    tree: Map<string, DirEntry[]>,
  ): void {
    if (currentDepth >= maxDepth) return;

    const entries = listDirectory(dirPath);
    tree.set(dirPath, entries);

    for (const entry of entries) {
      if (entry.isDir && !WATCH_BLACKLIST.has(entry.name)) {
        this.walkTree(join(dirPath, entry.name), currentDepth + 1, maxDepth, tree);
      }
    }
  }

  /**
   * 停止所有监控，清理 throttle 定时器
   */
  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.throttleTimers.values()) {
      clearTimeout(timer);
    }
    this.throttleTimers.clear();
  }
}
