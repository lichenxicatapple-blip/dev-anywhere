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

  it("exposes Write content as an added diff detail", () => {
    expect(
      getClaudeToolActivityDetails("Write", {
        file_path: "/tmp/result.txt",
        content: "line 1\nline 2",
      }),
    ).toEqual([
      {
        kind: "diff",
        title: "新增内容",
        content: "line 1\nline 2",
        oldContent: "",
        newContent: "line 1\nline 2",
      },
    ]);
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

  it("summarizes Codex patch activity and exposes it as a diff detail", () => {
    const input = {
      file_path: "/tmp/project/a.txt",
      content: "@@ -1 +1 @@\n-old\n+new\n",
      changes: [
        {
          path: "/tmp/project/a.txt",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    };

    expect(summarizeClaudeToolActivity("Patch", input)).toBe("应用补丁：/tmp/project/a.txt");
    expect(getClaudeToolActivityDetails("Patch", input)).toEqual([
      {
        kind: "diff",
        title: "更新：/tmp/project/a.txt",
        content: "@@ -1 +1 @@\n-old\n+new\n",
        oldContent: "old",
        newContent: "new",
      },
    ]);
  });

  it("renders Codex added files as all-added diff details", () => {
    const diff = [
      "diff --git a/hello_world.rs b/hello_world.rs",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/hello_world.rs",
      "@@ -0,0 +1,3 @@",
      "+fn main() {",
      '+    println!("Hello, world!");',
      "+}",
      "",
    ].join("\n");

    expect(
      getClaudeToolActivityDetails("Patch", {
        file_path: "/tmp/hello_world.rs",
        changes: [
          {
            path: "/tmp/hello_world.rs",
            kind: "add",
            diff,
          },
        ],
      }),
    ).toEqual([
      {
        kind: "diff",
        title: "新增：/tmp/hello_world.rs",
        content: diff,
        oldContent: "",
        newContent: 'fn main() {\n    println!("Hello, world!");\n}',
      },
    ]);
  });

  it("renders Codex added files sent as plain content as all-added diff details", () => {
    const content = "# Rust Hello World Feature Demo Design\n\n## Goal\n\nCreate a demo.\n";

    expect(
      getClaudeToolActivityDetails("Patch", {
        file_path: "/tmp/design.md",
        changes: [
          {
            path: "/tmp/design.md",
            kind: "add",
            diff: content,
          },
        ],
      }),
    ).toEqual([
      {
        kind: "diff",
        title: "新增：/tmp/design.md",
        content,
        oldContent: "",
        newContent: content,
      },
    ]);
  });

  it("uses a generic native tool label for unknown tools", () => {
    expect(summarizeClaudeToolActivity("CustomTool", { token: "abc" })).toBe(
      "使用工具：CustomTool",
    );
  });
});
