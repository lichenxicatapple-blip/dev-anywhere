import { describe, expect, it } from "vitest";
import {
  getClaudeToolActivityDetails,
  summarizeClaudeToolActivity,
} from "./claude-activity-summary";

describe("summarizeClaudeToolActivity", () => {
  it("summarizes Bash commands without leaking obvious secrets", () => {
    const summary = summarizeClaudeToolActivity("Bash", {
      command: "curl https://api.example.test -H 'Authorization: Bearer abc123' --token=secret",
    });

    expect(summary).toContain("运行命令");
    expect(summary).toContain("curl https://api.example.test");
    expect(summary).not.toContain("abc123");
    expect(summary).not.toContain("secret");
  });

  it("summarizes file tools by file path without dumping content into the summary line", () => {
    const summary = summarizeClaudeToolActivity("Write", {
      file_path: "/tmp/result.txt",
      content: "very long private content",
    });

    expect(summary).toBe("写入文件：/tmp/result.txt");
    expect(summary).not.toContain("very long private content");
  });

  it("exposes raw Write content as collapsed activity details", () => {
    expect(
      getClaudeToolActivityDetails("Write", {
        file_path: "/tmp/result.txt",
        content: "line 1\nline 2",
      }),
    ).toEqual([{ title: "写入内容", content: "line 1\nline 2" }]);
  });

  it("exposes raw Edit replacement text as a collapsed diff detail", () => {
    expect(
      getClaudeToolActivityDetails("Edit", {
        file_path: "/tmp/result.txt",
        old_string: "before\ntext",
        new_string: "after\ntext",
      }),
    ).toEqual([
      {
        kind: "diff",
        title: "变更预览",
        content: "before\ntext\nafter\ntext",
        oldContent: "before\ntext",
        newContent: "after\ntext",
      },
    ]);
  });

  it("exposes raw MultiEdit replacement text as per-edit diff details", () => {
    expect(
      getClaudeToolActivityDetails("MultiEdit", {
        file_path: "/tmp/result.txt",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      }),
    ).toEqual([
      {
        kind: "diff",
        title: "第 1 处变更",
        content: "a\nb",
        oldContent: "a",
        newContent: "b",
      },
      {
        kind: "diff",
        title: "第 2 处变更",
        content: "c\nd",
        oldContent: "c",
        newContent: "d",
      },
    ]);
  });

  it("uses a generic native tool label for unknown tools", () => {
    expect(summarizeClaudeToolActivity("CustomTool", { token: "abc" })).toBe(
      "使用工具：CustomTool",
    );
  });
});
