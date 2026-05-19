import { describe, expect, it } from "vitest";
import { fallbackSpeechSummary } from "./fallback-summary";

describe("fallbackSpeechSummary", () => {
  it("explains that code details should be checked visually", () => {
    expect(fallbackSpeechSummary("code")).toBe(
      "这条回复包含代码，我先概括：它给出了一段实现或配置，请查看屏幕确认细节。",
    );
  });

  it("has category-specific fallbacks for table and diagnostic content", () => {
    expect(fallbackSpeechSummary("table")).toContain("包含表格");
    expect(fallbackSpeechSummary("diff")).toContain("包含代码变更");
    expect(fallbackSpeechSummary("stack_trace")).toContain("包含错误堆栈");
    expect(fallbackSpeechSummary("long_text")).toContain("内容较长");
  });
});
