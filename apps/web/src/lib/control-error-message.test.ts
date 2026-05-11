import { describe, expect, it } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { describeControlError } from "./control-error-message";

describe("describeControlError", () => {
  it("maps known errorCodes to friendly Chinese text", () => {
    expect(
      describeControlError({
        errorCode: ControlErrorCode.PATH_NOT_FOUND,
        rawError: "ENOENT: no such file or directory",
        fallback: "下载失败",
      }),
    ).toBe("文件不存在");

    expect(
      describeControlError({
        errorCode: ControlErrorCode.PATH_ACCESS_DENIED,
        rawError: "EACCES: permission denied",
        fallback: "下载失败",
      }),
    ).toBe("无权访问该路径");

    expect(
      describeControlError({
        errorCode: ControlErrorCode.SESSION_NOT_FOUND,
        rawError: "session not found",
        fallback: "下载失败",
      }),
    ).toBe("会话已结束");
  });

  it("falls back to rawError for UNKNOWN errorCode", () => {
    expect(
      describeControlError({
        errorCode: ControlErrorCode.UNKNOWN,
        rawError: "文件超过 100MB 限制",
        fallback: "下载失败",
      }),
    ).toBe("文件超过 100MB 限制");
  });

  it("falls back to rawError when errorCode is missing entirely", () => {
    expect(
      describeControlError({ rawError: "transport closed mid-flight", fallback: "下载失败" }),
    ).toBe("transport closed mid-flight");
  });

  it("uses fallback when both errorCode mapping and rawError are absent", () => {
    expect(describeControlError({ fallback: "下载失败" })).toBe("下载失败");
    expect(
      describeControlError({ errorCode: ControlErrorCode.UNKNOWN, fallback: "下载失败" }),
    ).toBe("下载失败");
  });

  it("treats whitespace-only rawError as missing", () => {
    expect(describeControlError({ rawError: "   ", fallback: "下载失败" })).toBe("下载失败");
  });
});
