import { describe, expect, it } from "vitest";
import { summarizeClaudeToolActivity } from "./claude-activity-summary";

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

  it("summarizes file tools by file path without dumping content", () => {
    const summary = summarizeClaudeToolActivity("Write", {
      file_path: "/tmp/result.txt",
      content: "very long private content",
    });

    expect(summary).toBe("写入文件：/tmp/result.txt");
    expect(summary).not.toContain("very long private content");
  });

  it("uses a generic native tool label for unknown tools", () => {
    expect(summarizeClaudeToolActivity("CustomTool", { token: "abc" })).toBe(
      "使用工具：CustomTool",
    );
  });
});
