import { describe, expect, it } from "vitest";
import { describeToolApprovalForSpeech } from "./tool-approval-speech";

describe("describeToolApprovalForSpeech", () => {
  it("summarizes bash commands with destructive-looking warning", () => {
    expect(
      describeToolApprovalForSpeech({
        toolName: "Bash",
        input: { command: "rm -rf dist && pnpm build" },
      }),
    ).toBe("工具 Bash 请求执行命令：rm -rf dist && pnpm build。看起来可能会删除或覆盖内容。");
  });

  it("mentions file paths and compact JSON inputs", () => {
    expect(
      describeToolApprovalForSpeech({
        toolName: "Edit",
        input: { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" },
      }),
    ).toBe("工具 Edit 请求操作路径：/repo/src/app.ts。参数包括 old_string、new_string。");
  });
});
