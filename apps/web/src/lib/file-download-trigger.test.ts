import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import type { ControlErrorCode as ControlErrorCodeType } from "@dev-anywhere/shared";
import { triggerFileDownload } from "./file-download-trigger";
import type { RelayClient } from "@/services/relay-client";

function makeRelayWithResponse(
  resp: Partial<{
    success: boolean;
    path: string;
    url: string;
    error: string;
    errorCode: ControlErrorCodeType;
  }>,
): RelayClient {
  return {
    requestRemoteFileUrl: vi.fn().mockResolvedValue({
      sessionId: "s1",
      success: resp.success ?? true,
      path: resp.path ?? "/tmp/x.log",
      url: resp.url,
      error: resp.error,
      errorCode: resp.errorCode,
    }),
  } as unknown as RelayClient;
}

describe("triggerFileDownload", () => {
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clickSpy = vi.fn();
    // 拦截 anchor click 防 jsdom 真去导航
    HTMLAnchorElement.prototype.click = clickSpy as unknown as () => void;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests a remote file URL and triggers browser download with file name from path", async () => {
    const relay = makeRelayWithResponse({
      url: "/api/remote-files/token-1",
      path: "/tmp/build.log",
    });

    const result = await triggerFileDownload({ relay, sessionId: "s1", path: "/tmp/build.log" });

    expect(result.ok).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(relay.requestRemoteFileUrl).toHaveBeenCalledWith("s1", "/tmp/build.log", "download");
  });

  it("returns an error with the requested path when proxy reports failure", async () => {
    const relay = makeRelayWithResponse({
      success: false,
      error: "文件不存在",
    });

    const result = await triggerFileDownload({ relay, sessionId: "s1", path: "/missing.log" });

    expect(result).toEqual({ ok: false, error: "下载失败：/missing.log（文件不存在）" });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("translates errorCode into Chinese and includes the requested path", async () => {
    const relay = makeRelayWithResponse({
      success: false,
      error: "ENOENT: no such file or directory, lstat '/abs/missing'",
      errorCode: ControlErrorCode.PATH_NOT_FOUND,
    });

    const result = await triggerFileDownload({ relay, sessionId: "s1", path: "/abs/missing" });

    expect(result).toEqual({ ok: false, error: "下载失败：/abs/missing（文件不存在）" });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("returns error when relay reports success but omits URL (defensive)", async () => {
    const relay = makeRelayWithResponse({
      success: true,
      url: undefined,
    });

    const result = await triggerFileDownload({ relay, sessionId: "s1", path: "/tmp/x.log" });

    expect(result).toEqual({ ok: false, error: "下载失败：/tmp/x.log" });
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
