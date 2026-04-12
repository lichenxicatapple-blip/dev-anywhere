// PTY 终端 scrollback 缓存，按 lineId 索引历史行数据，支持缺失检测和边界追踪
import type { TermLine } from "@cc-anywhere/shared";

interface LinesResponse {
  fromLineId: number;
  oldestLineId: number;
  newestLineId: number;
  lines: TermLine[];
}

export class ScrollbackCache {
  applyLinesResponse(_response: LinesResponse): void {
    throw new Error("not implemented");
  }

  getCachedLines(_fromLineId: number, _count: number): Array<TermLine | null> {
    throw new Error("not implemented");
  }

  getMissingRange(_fromLineId: number, _count: number): { fromLineId: number; count: number } | null {
    throw new Error("not implemented");
  }

  isAtOldest(_fromLineId: number): boolean {
    throw new Error("not implemented");
  }

  clearCache(): void {
    throw new Error("not implemented");
  }

  get cacheSize(): number {
    throw new Error("not implemented");
  }

  get oldestLineId(): number {
    throw new Error("not implemented");
  }

  get newestLineId(): number {
    throw new Error("not implemented");
  }
}
