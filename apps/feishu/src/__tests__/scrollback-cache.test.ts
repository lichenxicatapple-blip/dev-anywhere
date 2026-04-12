import { describe, it, expect, beforeEach } from "vitest";
import { ScrollbackCache } from "@/services/scrollback-cache";
import type { TermLine } from "@cc-anywhere/shared";

function makeLine(text: string): TermLine {
  return [{ text }];
}

function makeLines(texts: string[]): TermLine[] {
  return texts.map(makeLine);
}

describe("ScrollbackCache", () => {
  let cache: ScrollbackCache;

  beforeEach(() => {
    cache = new ScrollbackCache();
  });

  describe("empty cache", () => {
    it("getCachedLines returns all nulls", () => {
      const result = cache.getCachedLines(0, 5);
      expect(result).toEqual([null, null, null, null, null]);
    });

    it("getMissingRange returns full range", () => {
      const result = cache.getMissingRange(0, 5);
      expect(result).toEqual({ fromLineId: 0, count: 5 });
    });

    it("cacheSize is 0", () => {
      expect(cache.cacheSize).toBe(0);
    });
  });

  describe("after applyLinesResponse", () => {
    beforeEach(() => {
      cache.applyLinesResponse({
        fromLineId: 10,
        oldestLineId: 5,
        newestLineId: 20,
        lines: makeLines(["line10", "line11", "line12"]),
      });
    });

    it("returns cached lines for stored lineIds", () => {
      const result = cache.getCachedLines(10, 3);
      expect(result).toEqual([
        makeLine("line10"),
        makeLine("line11"),
        makeLine("line12"),
      ]);
    });

    it("updates boundary tracking", () => {
      expect(cache.oldestLineId).toBe(5);
      expect(cache.newestLineId).toBe(20);
    });

    it("cacheSize reflects stored lines", () => {
      expect(cache.cacheSize).toBe(3);
    });

    it("returns null for uncached lineIds within range", () => {
      const result = cache.getCachedLines(8, 5);
      expect(result).toEqual([
        null,
        null,
        makeLine("line10"),
        makeLine("line11"),
        makeLine("line12"),
      ]);
    });
  });

  describe("getMissingRange with partial cache", () => {
    beforeEach(() => {
      cache.applyLinesResponse({
        fromLineId: 10,
        oldestLineId: 0,
        newestLineId: 20,
        lines: makeLines(["line10", "line11", "line12"]),
      });
    });

    it("returns narrowed range for partially cached request", () => {
      const result = cache.getMissingRange(8, 7);
      // lineIds 8,9 are missing, 10,11,12 are cached, 13,14 are missing
      // contiguous uncovered range from first miss
      expect(result).not.toBeNull();
      expect(result!.fromLineId).toBe(8);
      expect(result!.count).toBeGreaterThanOrEqual(2);
    });

    it("returns null when fully cached", () => {
      const result = cache.getMissingRange(10, 3);
      expect(result).toBeNull();
    });
  });

  describe("isAtOldest", () => {
    beforeEach(() => {
      cache.applyLinesResponse({
        fromLineId: 5,
        oldestLineId: 5,
        newestLineId: 20,
        lines: makeLines(["line5", "line6"]),
      });
    });

    it("returns true when fromLineId equals oldestLineId", () => {
      expect(cache.isAtOldest(5)).toBe(true);
    });

    it("returns true when fromLineId is less than oldestLineId", () => {
      expect(cache.isAtOldest(3)).toBe(true);
    });

    it("returns false when fromLineId is greater than oldestLineId", () => {
      expect(cache.isAtOldest(6)).toBe(false);
    });
  });

  describe("clearCache", () => {
    it("resets cache to empty", () => {
      cache.applyLinesResponse({
        fromLineId: 10,
        oldestLineId: 5,
        newestLineId: 20,
        lines: makeLines(["line10"]),
      });
      expect(cache.cacheSize).toBe(1);

      cache.clearCache();

      expect(cache.cacheSize).toBe(0);
      expect(cache.getCachedLines(10, 1)).toEqual([null]);
    });
  });

  describe("multiple applyLinesResponse calls", () => {
    it("accumulates lines in cache", () => {
      cache.applyLinesResponse({
        fromLineId: 10,
        oldestLineId: 5,
        newestLineId: 20,
        lines: makeLines(["line10", "line11"]),
      });
      cache.applyLinesResponse({
        fromLineId: 5,
        oldestLineId: 5,
        newestLineId: 20,
        lines: makeLines(["line5", "line6", "line7"]),
      });

      expect(cache.cacheSize).toBe(5);
      expect(cache.getCachedLines(5, 8)).toEqual([
        makeLine("line5"),
        makeLine("line6"),
        makeLine("line7"),
        null, // lineId 8
        null, // lineId 9
        makeLine("line10"),
        makeLine("line11"),
        null, // lineId 12
      ]);
    });

    it("updates boundaries from latest response", () => {
      cache.applyLinesResponse({
        fromLineId: 10,
        oldestLineId: 10,
        newestLineId: 20,
        lines: makeLines(["line10"]),
      });
      cache.applyLinesResponse({
        fromLineId: 5,
        oldestLineId: 3,
        newestLineId: 25,
        lines: makeLines(["line5"]),
      });

      expect(cache.oldestLineId).toBe(3);
      expect(cache.newestLineId).toBe(25);
    });
  });
});
