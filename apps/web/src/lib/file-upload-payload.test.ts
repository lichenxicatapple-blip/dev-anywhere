import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadFile, toastLoading, toastSuccess, toastError, toastDismiss } = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  toastLoading: vi.fn(() => "loading-id"),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  toast: {
    loading: toastLoading,
    success: toastSuccess,
    error: toastError,
    dismiss: toastDismiss,
  },
}));

import { uploadFileAndShowToast } from "./file-upload-payload";
import type { RelayClient } from "@/services/relay-client";

describe("uploadFileAndShowToast", () => {
  beforeEach(() => {
    uploadFile.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    toastSuccess.mockReset();
    toastError.mockReset();
    toastDismiss.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  function relayWith(result: unknown): RelayClient {
    uploadFile.mockResolvedValue(result);
    return { uploadFile } as unknown as RelayClient;
  }

  function makeFile(name = "notes.txt", type = "text/plain"): File {
    return new File([new Uint8Array([0x41, 0x42, 0x43])], name, { type });
  }

  it("returns the path and shows default success toast on success", async () => {
    const file = makeFile();
    const path = await uploadFileAndShowToast({
      relay: relayWith({ success: true, path: ".dev-anywhere/uploads/s1/notes.txt" }),
      sessionId: "s1",
      file,
    });
    expect(path).toBe(".dev-anywhere/uploads/s1/notes.txt");
    expect(uploadFile).toHaveBeenCalledWith("s1", file);
    expect(toastSuccess).toHaveBeenCalledWith("已上传 .dev-anywhere/uploads/s1/notes.txt", {
      id: "loading-id",
    });
    expect(toastDismiss).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("dismisses loading toast without success label when successLabel is null", async () => {
    const path = await uploadFileAndShowToast({
      relay: relayWith({ success: true, path: "uploaded/x.bin" }),
      sessionId: "s1",
      file: makeFile(),
      successLabel: null,
    });
    expect(path).toBe("uploaded/x.bin");
    expect(toastDismiss).toHaveBeenCalledWith("loading-id");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("uses custom successLabel when provided", async () => {
    await uploadFileAndShowToast({
      relay: relayWith({ success: true, path: "p" }),
      sessionId: "s1",
      file: makeFile(),
      successLabel: "自定义文案",
    });
    expect(toastSuccess).toHaveBeenCalledWith("自定义文案", { id: "loading-id" });
  });

  it("returns null and shows error toast when relay reports failure", async () => {
    const path = await uploadFileAndShowToast({
      relay: relayWith({ success: false, error: "磁盘满" }),
      sessionId: "s1",
      file: makeFile(),
    });
    expect(path).toBeNull();
    expect(toastError).toHaveBeenCalledWith("磁盘满", { id: "loading-id" });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("falls back to generic error label when relay omits the error", async () => {
    const path = await uploadFileAndShowToast({
      relay: relayWith({ success: false }),
      sessionId: "s1",
      file: makeFile(),
    });
    expect(path).toBeNull();
    expect(toastError).toHaveBeenCalledWith("上传失败", { id: "loading-id" });
  });

  it("returns null and surfaces the thrown error via toast on payload/upload exception", async () => {
    uploadFile.mockRejectedValue(new Error("network broken"));
    const path = await uploadFileAndShowToast({
      relay: { uploadFile } as unknown as RelayClient,
      sessionId: "s1",
      file: makeFile(),
    });
    expect(path).toBeNull();
    expect(toastError).toHaveBeenCalledWith("network broken", { id: "loading-id" });
  });
});
