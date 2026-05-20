import { describe, expect, it } from "vitest";
import { describeToolApprovalForSpeech } from "./tool-approval-speech";

describe("describeToolApprovalForSpeech", () => {
  it("summarizes bash commands without reading the raw command", () => {
    expect(
      describeToolApprovalForSpeech({
        toolName: "Bash",
        input: { command: "rm -rf dist && pnpm build" },
      }),
    ).toBe("工具 Bash 请求执行命令。");
  });

  it("mentions a compact file path without parameter lists", () => {
    expect(
      describeToolApprovalForSpeech({
        toolName: "Edit",
        input: { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" },
      }),
    ).toBe("工具 Edit 请求操作 src/app.ts。");
  });

  it("summarizes search tools with enough query context", () => {
    expect(
      describeToolApprovalForSpeech({
        toolName: "mcp__serper__web_search",
        input: { query: "SOSP 2025 accepted papers operating systems", num: 10 },
      }),
    ).toBe(
      "工具 mcp__serper__web_search 请求搜索：SOSP 2025 accepted papers operating systems，最多返回 10 条。",
    );
  });
});
