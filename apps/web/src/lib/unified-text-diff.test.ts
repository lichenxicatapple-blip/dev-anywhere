import { describe, expect, it } from "vitest";
import { buildUnifiedTextDiff } from "./unified-text-diff";

describe("buildUnifiedTextDiff", () => {
  it("builds line-level rows with context, removals, and additions", () => {
    expect(buildUnifiedTextDiff("same\nold\nkeep", "same\nnew\nkeep")).toEqual([
      { type: "context", text: "same", oldLineNumber: 1, newLineNumber: 1 },
      { type: "remove", text: "old", oldLineNumber: 2, newLineNumber: null },
      { type: "add", text: "new", oldLineNumber: null, newLineNumber: 2 },
      { type: "context", text: "keep", oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });

  it("keeps inserted and deleted empty lines visible", () => {
    expect(buildUnifiedTextDiff("a\n\nb", "a\nb")).toEqual([
      { type: "context", text: "a", oldLineNumber: 1, newLineNumber: 1 },
      { type: "remove", text: "", oldLineNumber: 2, newLineNumber: null },
      { type: "context", text: "b", oldLineNumber: 3, newLineNumber: 2 },
    ]);
  });
});
