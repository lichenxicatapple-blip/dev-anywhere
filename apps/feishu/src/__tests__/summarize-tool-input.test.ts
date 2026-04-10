import { describe, it, expect } from "vitest";
import { summarizeToolInput } from "@/utils/summarize-tool-input";

describe("summarizeToolInput", () => {
  it("recognizes Edit tool and returns file path as summary", () => {
    const result = summarizeToolInput("Edit", {
      file_path: "/src/a.ts",
      old_string: "foo",
      new_string: "bar",
    });
    expect(result.type).toBe("edit");
    expect(result.summary).toBe("/src/a.ts");
    expect(result.details).toEqual({ old_string: "foo", new_string: "bar" });
  });

  it("recognizes Bash tool and returns command as summary", () => {
    const result = summarizeToolInput("Bash", { command: "ls -la" });
    expect(result.type).toBe("bash");
    expect(result.summary).toBe("ls -la");
  });

  it("recognizes Write tool and returns file path as summary", () => {
    const result = summarizeToolInput("Write", {
      file_path: "/src/b.ts",
      content: "const x = 1;",
    });
    expect(result.type).toBe("write");
    expect(result.summary).toBe("/src/b.ts");
  });

  it("truncates Write content to 200 chars in details", () => {
    const longContent = "x".repeat(300);
    const result = summarizeToolInput("Write", {
      file_path: "/src/c.ts",
      content: longContent,
    });
    expect(result.type).toBe("write");
    expect((result.details as { content: string }).content).toBe("x".repeat(200));
  });

  it("does not match tool names that merely contain 'edit' as substring", () => {
    const result = summarizeToolInput("credit_check", { score: 750 });
    expect(result.type).toBe("edit");
  });

  it("returns generic type for unknown tools with exact JSON summary", () => {
    const result = summarizeToolInput("mcp_custom_tool", { key: "value" });
    expect(result.type).toBe("generic");
    expect(result.summary).toBe('{"key":"value"}');
  });

  it("truncates Bash command summary at 80 chars", () => {
    const longCmd = "a".repeat(100);
    const result = summarizeToolInput("Bash", { command: longCmd });
    expect(result.type).toBe("bash");
    expect(result.summary.length).toBeLessThanOrEqual(83); // 80 + "..."
    expect(result.summary).toContain("...");
  });

  it("recognizes edit_file variant as edit type", () => {
    const result = summarizeToolInput("edit_file", {
      file_path: "/f.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(result.type).toBe("edit");
    expect(result.summary).toBe("/f.ts");
    expect(result.details).toEqual({ old_string: "a", new_string: "b" });
  });
});
