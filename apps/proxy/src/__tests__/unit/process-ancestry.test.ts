import { describe, expect, it, vi } from "vitest";
import { findClosestAncestorPid, parseParentPid } from "#src/common/process-ancestry.js";

describe("process ancestry", () => {
  it("selects the closest managed ancestor of a writer process", () => {
    const parents = new Map([
      [46559, 46556],
      [46556, 46546],
      [46546, 38569],
      [38569, 1],
    ]);
    const lookup = vi.fn((pid: number) => parents.get(pid) ?? null);

    expect(findClosestAncestorPid(46559, [38569, 46546], lookup)).toBe(46546);
    expect(lookup).toHaveBeenCalledWith(46559);
    expect(lookup).toHaveBeenCalledWith(46556);
  });

  it("treats the writer PID itself as a managed process", () => {
    const lookup = vi.fn(() => null);
    expect(findClosestAncestorPid(46559, [46559], lookup)).toBe(46559);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("fails closed for unrelated and cyclic process trees", () => {
    expect(findClosestAncestorPid(20, [99], (pid) => (pid === 20 ? 10 : 1))).toBeNull();
    expect(findClosestAncestorPid(20, [99], (pid) => (pid === 20 ? 10 : 20))).toBeNull();
  });

  it("parses only a positive parent PID", () => {
    expect(parseParentPid("  46556\n")).toBe(46556);
    expect(parseParentPid("ParentProcessId\r\n46556\r\n")).toBe(46556);
    expect(parseParentPid("0\n")).toBeNull();
    expect(parseParentPid("missing")).toBeNull();
  });
});
