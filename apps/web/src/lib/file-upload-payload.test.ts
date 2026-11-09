import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  uploadFile,
  uploadClipboardImage,
  compressLargeImageForUpload,
  toastLoading,
  toastSuccess,
  toastError,
  toastDismiss,
} = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  uploadClipboardImage: vi.fn(),
  compressLargeImageForUpload: vi.fn(async (file: File) => file),
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

vi.mock("./image-upload-compression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./image-upload-compression")>()),
  compressLargeImageForUpload,
}));

import { uploadFilesAndShowToast } from "./file-upload-payload";
import type { RelayClient } from "@/services/relay-client";

describe("uploadFilesAndShowToast", () => {
  const relay = { uploadFile, uploadClipboardImage } as unknown as RelayClient;
  const makeFile = (name: string, type = "text/plain") => new File(["fixture"], name, { type });

  beforeEach(() => {
    uploadFile.mockReset();
    uploadClipboardImage.mockReset();
    compressLargeImageForUpload.mockReset();
    compressLargeImageForUpload.mockImplementation(async (file: File) => file);
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    toastSuccess.mockReset();
    toastError.mockReset();
    toastDismiss.mockReset();
  });

  it("uploads one at a time and publishes each result in order, retaining same-name files", async () => {
    const first = makeFile("same.txt");
    const second = makeFile("same.txt");
    let finishFirst!: (result: { success: boolean; path: string }) => void;
    uploadFile
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce({ success: true, path: "uploads/second.txt" });
    const events: string[] = [];
    compressLargeImageForUpload.mockImplementation(async (file: File) => {
      events.push(file === first ? "prepare first" : "prepare second");
      return file;
    });
    const onUploaded = vi.fn((file: File) => {
      events.push(file === first ? "publish first" : "publish second");
    });
    const pending = uploadFilesAndShowToast({
      relay,
      sessionId: "s1",
      files: [first, second],
      onUploaded,
    });
    await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(compressLargeImageForUpload).toHaveBeenCalledTimes(1);
    expect(onUploaded).not.toHaveBeenCalled();

    finishFirst({ success: true, path: "uploads/first.txt" });
    await expect(pending).resolves.toEqual([
      { file: first, path: "uploads/first.txt" },
      { file: second, path: "uploads/second.txt" },
    ]);
    expect(events).toEqual(["prepare first", "publish first", "prepare second", "publish second"]);
    expect(onUploaded).toHaveBeenNthCalledWith(1, first, "uploads/first.txt");
    expect(onUploaded).toHaveBeenNthCalledWith(2, second, "uploads/second.txt");
    expect(toastLoading.mock.calls).toEqual([
      ["正在上传 same.txt (1/2)"],
      ["正在上传 same.txt (2/2)", { id: "loading-id" }],
    ]);
    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith("已上传 2 个文件", { id: "loading-id" });
  });

  it("continues after rejected uploads, server errors and preparation errors, reporting filenames together", async () => {
    const files = ["denied.txt", "offline.txt", "prepare.png", "ok.txt"].map((name) =>
      makeFile(name),
    );
    compressLargeImageForUpload.mockImplementation(async (file: File) => {
      if (file.name === "prepare.png") throw new Error("cannot prepare");
      return file;
    });
    uploadFile
      .mockResolvedValueOnce({ success: false, error: "磁盘满" })
      .mockRejectedValueOnce(new Error("连接已断开"))
      .mockResolvedValueOnce({ success: true, path: "uploads/ok.txt" });
    const onUploaded = vi.fn();

    await expect(
      uploadFilesAndShowToast({ relay, sessionId: "s1", files, onUploaded, successLabel: null }),
    ).resolves.toEqual([{ file: files[3], path: "uploads/ok.txt" }]);

    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(onUploaded).toHaveBeenCalledExactlyOnceWith(files[3], "uploads/ok.txt");
    expect(toastError).toHaveBeenCalledExactlyOnceWith("已上传 1/4 个文件", {
      id: "loading-id",
      description: "denied.txt：磁盘满\noffline.txt：连接已断开\nprepare.png：cannot prepare",
    });
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastDismiss).not.toHaveBeenCalled();
  });

  it("keeps the old clipboard endpoint for supported images and uses file upload for everything else", async () => {
    const types = [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/bmp",
      "text/plain",
      "",
    ];
    const files = types.map((type, index) => makeFile(`file-${index}`, type));
    uploadClipboardImage.mockImplementation(async (_id, file: File) => ({
      success: true,
      path: `clipboard/${file.name}`,
    }));
    uploadFile.mockImplementation(async (_id, file: File) => ({
      success: true,
      path: `uploads/${file.name}`,
    }));

    const result = await uploadFilesAndShowToast({
      relay,
      sessionId: "s1",
      files,
      clipboard: true,
    });

    expect(uploadClipboardImage.mock.calls).toEqual(files.slice(0, 4).map((file) => ["s1", file]));
    expect(uploadFile.mock.calls).toEqual(files.slice(4).map((file) => ["s1", file]));
    expect(result.map(({ file }) => file)).toEqual(files);
    expect(result.map(({ path }) => path)).toEqual(
      types.map((_, index) => `${index < 4 ? "clipboard" : "uploads"}/file-${index}`),
    );
  });

  it.each([false, true])(
    "uploads the prepared file while returning its original identity (clipboard=%s)",
    async (clipboard) => {
      const original = new File([new Uint8Array(3 * 1024 * 1024)], "large.png", {
        type: "image/png",
      });
      const compressed = makeFile("large.webp", "image/webp");
      compressLargeImageForUpload.mockResolvedValueOnce(compressed);
      const endpoint = clipboard ? uploadClipboardImage : uploadFile;
      endpoint.mockResolvedValueOnce({ success: true, path: "uploaded/large.webp" });
      const onUploaded = vi.fn();

      await expect(
        uploadFilesAndShowToast({
          relay,
          sessionId: "s1",
          files: [original],
          clipboard,
          onUploaded,
        }),
      ).resolves.toEqual([{ file: original, path: "uploaded/large.webp" }]);

      expect(endpoint).toHaveBeenCalledExactlyOnceWith("s1", compressed);
      expect(onUploaded).toHaveBeenCalledExactlyOnceWith(original, "uploaded/large.webp");
      expect(toastLoading).toHaveBeenCalledWith("正在压缩并上传 large.png (1/1)");
    },
  );

  it("dismisses the shared progress toast after full success when the caller owns success feedback", async () => {
    uploadFile.mockResolvedValue({ success: true, path: "uploaded/file" });
    await uploadFilesAndShowToast({
      relay,
      sessionId: "s1",
      files: [makeFile("a"), makeFile("b")],
      successLabel: null,
    });
    expect(toastDismiss).toHaveBeenCalledExactlyOnceWith("loading-id");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("uses a custom final success label", async () => {
    uploadFile.mockResolvedValue({ success: true, path: "uploaded/file" });
    await uploadFilesAndShowToast({
      relay,
      sessionId: "s1",
      files: [makeFile("a")],
      successLabel: "附件已添加",
    });
    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith("附件已添加", { id: "loading-id" });
  });

  it("reports a missing path as a failed upload with its filename", async () => {
    uploadFile.mockResolvedValue({ success: true });
    await expect(
      uploadFilesAndShowToast({ relay, sessionId: "s1", files: [makeFile("empty.txt")] }),
    ).resolves.toEqual([]);
    expect(toastError).toHaveBeenCalledExactlyOnceWith("已上传 0/1 个文件", {
      id: "loading-id",
      description: "empty.txt：上传失败",
    });
  });

  it("keeps uploading if a result consumer throws, retaining already uploaded paths", async () => {
    uploadFile.mockImplementation(async (_id, file: File) => ({
      success: true,
      path: `uploaded/${file.name}`,
    }));
    const files = [makeFile("first.txt"), makeFile("next.txt")];
    const onUploaded = vi.fn().mockImplementationOnce(() => {
      throw new Error("cannot attach");
    });
    const results = await uploadFilesAndShowToast({ relay, sessionId: "s1", files, onUploaded });
    expect(results).toEqual(files.map((file) => ({ file, path: `uploaded/${file.name}` })));
    expect(onUploaded).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenCalledWith("已上传 2/2 个文件", {
      id: "loading-id",
      description: "first.txt：已上传，但无法添加附件（cannot attach）",
    });
  });

  it("does nothing for an empty batch", async () => {
    await expect(uploadFilesAndShowToast({ relay, sessionId: "s1", files: [] })).resolves.toEqual(
      [],
    );
    expect(toastLoading).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(uploadClipboardImage).not.toHaveBeenCalled();
  });
});
