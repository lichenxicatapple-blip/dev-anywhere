// PTY 终端 scrollback 缓存，按 lineId 索引历史行数据，支持缺失检测和边界追踪
import type { TermLine } from "@cc-anywhere/shared";

interface LinesResponse {
  fromLineId: number;
  oldestLineId: number;
  newestLineId: number;
  lines: TermLine[];
}

export class ScrollbackCache {
  private cache = new Map<number, TermLine>();
  private _oldestLineId = 0;
  private _newestLineId = 0;

  applyLinesResponse(response: LinesResponse): void {
    this._oldestLineId = response.oldestLineId;
    this._newestLineId = response.newestLineId;

    for (let i = 0; i < response.lines.length; i++) {
      const lineId = response.fromLineId + i;
      this.cache.set(lineId, response.lines[i]);
    }
  }

  getCachedLines(fromLineId: number, count: number): Array<TermLine | null> {
    const result: Array<TermLine | null> = [];
    for (let i = 0; i < count; i++) {
      result.push(this.cache.get(fromLineId + i) ?? null);
    }
    return result;
  }

  getMissingRange(fromLineId: number, count: number): { fromLineId: number; count: number } | null {
    let missingStart = -1;
    let missingEnd = -1;

    for (let i = 0; i < count; i++) {
      const id = fromLineId + i;
      if (!this.cache.has(id)) {
        if (missingStart === -1) missingStart = id;
        missingEnd = id;
      }
    }

    if (missingStart === -1) return null;
    return { fromLineId: missingStart, count: missingEnd - missingStart + 1 };
  }

  isAtOldest(fromLineId: number): boolean {
    return fromLineId <= this._oldestLineId;
  }

  clearCache(): void {
    this.cache.clear();
    this._oldestLineId = 0;
    this._newestLineId = 0;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  get oldestLineId(): number {
    return this._oldestLineId;
  }

  get newestLineId(): number {
    return this._newestLineId;
  }
}
