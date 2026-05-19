import { describe, expect, it } from "vitest";
import { decideSpeechPolicy } from "./speech-policy";

describe("decideSpeechPolicy", () => {
  it("speaks normal prose directly", () => {
    expect(decideSpeechPolicy("已经完成，可以继续下一步。")).toEqual({ mode: "direct" });
  });

  it("requires summaries for hard-to-speak formats", () => {
    expect(decideSpeechPolicy("```ts\nconst x = 1;\n```")).toEqual({
      mode: "summary_required",
      reason: "code",
    });
    expect(decideSpeechPolicy("| 文件 | 状态 |\n| --- | --- |\n| a.ts | ok |")).toEqual({
      mode: "summary_required",
      reason: "table",
    });
    expect(decideSpeechPolicy("+ added\n- removed")).toEqual({
      mode: "summary_required",
      reason: "diff",
    });
    expect(decideSpeechPolicy("Error: boom\n    at run (/tmp/a.js:1:2)")).toEqual({
      mode: "summary_required",
      reason: "stack_trace",
    });
  });

  it("summarizes long lists and long prose", () => {
    const longList = Array.from({ length: 9 }, (_, i) => `- item ${i}`).join("\n");
    expect(decideSpeechPolicy(longList)).toEqual({
      mode: "summary_required",
      reason: "long_list",
    });
    expect(decideSpeechPolicy("说明".repeat(400), { maxDirectChars: 200 })).toEqual({
      mode: "summary_required",
      reason: "long_text",
    });
  });
});
