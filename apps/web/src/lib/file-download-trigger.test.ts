import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import type { ControlErrorCode as ControlErrorCodeType } from "@dev-anywhere/shared";
import { triggerFileDownload } from "./file-download-trigger";
import type { RelayClient } from "@/services/relay-client";

function makeRelayWithResponse(
  resp: Partial<{
    success: boolean;
    path: string;
    mimeType: string;
    dataBase64: string;
    size: number;
    error: string;
    errorCode: ControlErrorCodeType;
  }>,
): RelayClient {
  return {
    requestFileDownload: vi.fn().mockResolvedValue({
      sessionId: "s1",
      success: resp.success ?? true,
      path: resp.path ?? "/tmp/x.log",
      mimeType: resp.mimeType,
      dataBase64: resp.dataBase64,
      size: resp.size,
      error: resp.error,
      errorCode: resp.errorCode,
    }),
  } as unknown as RelayClient;
}

describe("triggerFileDownload", () => {
  let createObjectURL: typeof URL.createObjectURL;
  let revokeObjectURL: typeof URL.revokeObjectURL;
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = URL.createObjectURL;
    revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn().mockReturnValue("blob:fake-url");
    URL.revokeObjectURL = vi.fn();
    clickSpy = vi.fn();
    // 拦截 anchor click 防 jsdom 真去导航
    HTMLAnchorElement.prototype.click = clickSpy as unknown as () => void;
  });

  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.useRealTimers();
  });

  it("creates a blob and triggers browser download with file name from path", async () => {
    const relay = makeRelayWithResponse({
      mimeType: "text/plain",
      dataBase64: Buffer.from("hello").toString("base64"),
      size: 5,
      path: "/tmp/build.log",
    });

    const result = await triggerFileDownload({ relay, sessionId: "s1", path: "/tmp/build.log" });

    expect(result.ok).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(relay.requestFileDownload).toHaveBeenCalledWith("s1", "/tmp/build.log");
  });

  it("returns error when proxy reports failure", async () => {
    const relay = makeRelayWithResponse({
      success: false,
      error: "文件不存在",
      dataBase64: undefined,
      mimeType: undefined,
    });

    const result = await triggerFileDownload({ relay, sessionId: "s1", path: "/missing.log" });

    expect(result).toEqual({ ok: false, error: "文件不存在" });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("translates errorCode into Chinese, ignoring raw fs error string", async () => {
    const relay = makeRelayWithResponse({
      success: false,
      error: "ENOENT: no such file or directory, lstat '/abs/missing'",
      errorCode: ControlErrorCode.PATH_NOT_FOUND,
      dataBase64: undefined,
      mimeType: undefined,
    });

    const result = await triggerFileDownload({ relay, sessionId: "s1", path: "/abs/missing" });

    expect(result).toEqual({ ok: false, error: "文件不存在" });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("returns error when proxy reports success but omits dataBase64 (defensive)", async () => {
    const relay = makeRelayWithResponse({
      success: true,
      mimeType: "text/plain",
      dataBase64: undefined,
    });

    const result = await triggerFileDownload({ relay, sessionId: "s1", path: "/tmp/x.log" });

    expect(result.ok).toBe(false);
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
