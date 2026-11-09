import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import type { ClipboardEvent, RefObject } from "react";

const {
  sendRemoteInputRaw,
  compressLargeImageForUpload,
  toastLoading,
  toastError,
  toastSuccess,
  toastDismiss,
  relayUploadFile,
  relayUploadClipboardImage,
} = vi.hoisted(() => ({
  sendRemoteInputRaw: vi.fn(),
  compressLargeImageForUpload: vi.fn(async (file: File) => file),
  toastLoading: vi.fn(() => "toast-id"),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastDismiss: vi.fn(),
  relayUploadFile: vi.fn(),
  relayUploadClipboardImage: vi.fn(),
}));

// Keep clipboard extraction and batch upload real; replace only their external boundaries.
vi.mock("@/lib/ansi-keys", () => ({ sendRemoteInputRaw }));
vi.mock("@/lib/image-upload-compression", () => ({
  compressLargeImageForUpload,
  shouldCompressImageForUpload: () => false,
}));
vi.mock("@/components/toast", () => ({
  toast: {
    loading: toastLoading,
    error: toastError,
    success: toastSuccess,
    dismiss: toastDismiss,
  },
}));
vi.mock("@/hooks/use-relay-setup", () => ({ relayClientRef: null }));

import { useTerminalPaste } from "./use-terminal-paste";
import * as relaySetup from "@/hooks/use-relay-setup";

function setRelay(value: unknown): void {
  Object.defineProperty(relaySetup, "relayClientRef", {
    value,
    writable: true,
    configurable: true,
  });
}

function makePasteEvent(opts: {
  files?: File[];
  items?: Array<{ kind: string; type: string; getAsFile: () => File | null }>;
}): ClipboardEvent<HTMLDivElement> {
  const clipboardData = {
    files: (opts.files ?? []) as unknown as FileList,
    items: (opts.items ?? []) as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
  return {
    clipboardData,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ClipboardEvent<HTMLDivElement>;
}

function imageFile(name = "shot.png", type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function textFile(name = "notes.txt", type = "text/plain"): File {
  return new File(["ABC"], name, { type });
}

function makeTerminalRef(): RefObject<Terminal | null> {
  return { current: { focus: vi.fn() } as unknown as Terminal };
}

function deferredUpload() {
  let resolve!: (result: { success: boolean; path: string }) => void;
  const promise = new Promise<{ success: boolean; path: string }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useTerminalPaste", () => {
  const onAfterPaste = vi.fn();
  let terminalRef: RefObject<Terminal | null>;

  beforeEach(() => {
    vi.clearAllMocks();
    compressLargeImageForUpload.mockReset();
    compressLargeImageForUpload.mockImplementation(async (file: File) => file);
    relayUploadFile.mockReset();
    relayUploadFile.mockImplementation(async (sessionId: string, file: File) => ({
      success: true,
      path: `.dev-anywhere/uploads/${sessionId}/${file.name}`,
    }));
    relayUploadClipboardImage.mockReset();
    relayUploadClipboardImage.mockImplementation(async (sessionId: string, file: File) => ({
      success: true,
      path: `.dev-anywhere/clipboard/${sessionId}/${file.name}`,
    }));
    terminalRef = makeTerminalRef();
    setRelay({ uploadFile: relayUploadFile, uploadClipboardImage: relayUploadClipboardImage });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderPaste(sessionId = "s1") {
    return renderHook(
      (props: {
        sessionId: string;
        terminalRef: RefObject<Terminal | null>;
        onAfterPaste: () => void;
      }) => useTerminalPaste(props),
      { initialProps: { sessionId, terminalRef, onAfterPaste } },
    );
  }

  it("uploads an image once when files and items both describe it", async () => {
    const file = imageFile();
    const event = makePasteEvent({
      files: [file],
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    });
    const { result } = renderPaste();

    await result.current(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(relayUploadClipboardImage).toHaveBeenCalledExactlyOnceWith("s1", file);
    expect(relayUploadFile).not.toHaveBeenCalled();
    expect(sendRemoteInputRaw).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "@.dev-anywhere/clipboard/s1/shot.png ",
    );
    expect(onAfterPaste).toHaveBeenCalledOnce();
    expect(terminalRef.current?.focus).toHaveBeenCalledOnce();
  });

  it("uploads all files sequentially and inserts their paths in one input after the batch", async () => {
    const first = deferredUpload();
    relayUploadFile.mockImplementationOnce(() => first.promise);
    const { result } = renderPaste();
    const pending = result.current(makePasteEvent({ files: [textFile(), textFile("second.txt")] }));
    await waitFor(() => expect(relayUploadFile).toHaveBeenCalledTimes(1));
    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
    expect(onAfterPaste).not.toHaveBeenCalled();

    first.resolve({ success: true, path: ".dev-anywhere/uploads/s1/notes.txt" });
    await pending;

    expect(relayUploadFile.mock.calls.map(([, file]) => file.name)).toEqual([
      "notes.txt",
      "second.txt",
    ]);
    expect(sendRemoteInputRaw).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "@.dev-anywhere/uploads/s1/notes.txt @.dev-anywhere/uploads/s1/second.txt ",
    );
    expect(onAfterPaste).toHaveBeenCalledOnce();
    expect(terminalRef.current?.focus).toHaveBeenCalledOnce();
  });

  it("preserves the order of mixed files and images while using each upload endpoint", async () => {
    const files = [
      textFile(),
      imageFile(),
      textFile("report.pdf", "application/pdf"),
      imageFile("other.jpg", "image/jpeg"),
    ];
    const { result } = renderPaste();

    await result.current(makePasteEvent({ files }));

    expect(relayUploadFile.mock.calls.map(([, file]) => file.name)).toEqual([
      "notes.txt",
      "report.pdf",
    ]);
    expect(relayUploadClipboardImage.mock.calls.map(([, file]) => file.name)).toEqual([
      "shot.png",
      "other.jpg",
    ]);
    expect(sendRemoteInputRaw).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "@.dev-anywhere/uploads/s1/notes.txt @.dev-anywhere/clipboard/s1/shot.png @.dev-anywhere/uploads/s1/report.pdf @.dev-anywhere/clipboard/s1/other.jpg ",
    );
  });

  it("extracts every file item when the browser provides no FileList", async () => {
    const files = [imageFile(), textFile()];
    const { result } = renderPaste();

    await result.current(
      makePasteEvent({
        items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      }),
    );

    expect(sendRemoteInputRaw).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "@.dev-anywhere/clipboard/s1/shot.png @.dev-anywhere/uploads/s1/notes.txt ",
    );
  });

  it("inserts only successful paths and continues after server errors and rejected requests", async () => {
    relayUploadFile.mockResolvedValueOnce({ success: false, error: "磁盘满" });
    relayUploadClipboardImage.mockRejectedValueOnce(new Error("network broken"));
    const { result } = renderPaste();

    await result.current(
      makePasteEvent({ files: [textFile("failed.txt"), imageFile(), textFile("ok.txt")] }),
    );

    expect(sendRemoteInputRaw).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "@.dev-anywhere/uploads/s1/ok.txt ",
    );
    expect(toastError).toHaveBeenCalledWith(
      "已上传 1/3 个文件",
      expect.objectContaining({
        description: expect.stringContaining("failed.txt：磁盘满"),
      }),
    );
    expect(toastError.mock.calls[0]?.[1].description).toContain("shot.png：network broken");
    expect(onAfterPaste).toHaveBeenCalledOnce();
  });

  it("does not insert, follow or focus when every upload fails", async () => {
    relayUploadFile.mockResolvedValue({ success: false, error: "磁盘满" });
    relayUploadClipboardImage.mockRejectedValue(new Error("network broken"));
    const { result } = renderPaste();

    await result.current(makePasteEvent({ files: [textFile(), imageFile()] }));

    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
    expect(onAfterPaste).not.toHaveBeenCalled();
    expect(terminalRef.current?.focus).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("已上传 0/2 个文件", expect.any(Object));
  });

  it("leaves text-only paste untouched for xterm's bracketed paste handling", async () => {
    const getAsFile = vi.fn(() => null);
    const event = makePasteEvent({ items: [{ kind: "string", type: "text/plain", getAsFile }] });
    const { result } = renderPaste();

    await result.current(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(getAsFile).not.toHaveBeenCalled();
    expect(relayUploadFile).not.toHaveBeenCalled();
    expect(relayUploadClipboardImage).not.toHaveBeenCalled();
    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
    expect(toastLoading).not.toHaveBeenCalled();
    expect(onAfterPaste).not.toHaveBeenCalled();
    expect(terminalRef.current?.focus).not.toHaveBeenCalled();
  });

  it("reports a disconnected relay without allowing file data into xterm", async () => {
    setRelay(null);
    const event = makePasteEvent({ files: [textFile(), imageFile()] });
    const { result } = renderPaste();

    await result.current(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledWith("请先连接开发机");
    expect(relayUploadFile).not.toHaveBeenCalled();
    expect(relayUploadClipboardImage).not.toHaveBeenCalled();
    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
  });

  it("finishes the original session's batch without following or focusing a newly selected session", async () => {
    const first = deferredUpload();
    relayUploadFile.mockImplementationOnce(() => first.promise);
    const { result, rerender } = renderPaste();
    const pending = result.current(makePasteEvent({ files: [textFile(), textFile("second.txt")] }));
    await waitFor(() => expect(relayUploadFile).toHaveBeenCalledTimes(1));
    const nextOnAfterPaste = vi.fn();
    // Keep the same Terminal to ensure session identity alone protects the new view.
    rerender({ sessionId: "s2", terminalRef, onAfterPaste: nextOnAfterPaste });

    first.resolve({ success: true, path: "uploaded/first.txt" });
    await pending;

    expect(relayUploadFile.mock.calls.map(([sessionId]) => sessionId)).toEqual(["s1", "s1"]);
    expect(sendRemoteInputRaw).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "@uploaded/first.txt @.dev-anywhere/uploads/s1/second.txt ",
    );
    expect(onAfterPaste).not.toHaveBeenCalled();
    expect(nextOnAfterPaste).not.toHaveBeenCalled();
    expect(terminalRef.current?.focus).not.toHaveBeenCalled();
  });

  it.each(["current", "ref"] as const)(
    "does not focus a replacement terminal in the same session (%s replaced)",
    async (replacement) => {
      const first = deferredUpload();
      relayUploadFile.mockImplementationOnce(() => first.promise);
      const oldTerminal = terminalRef.current;
      const { result, rerender } = renderPaste();
      const pending = result.current(makePasteEvent({ files: [textFile()] }));
      await waitFor(() => expect(relayUploadFile).toHaveBeenCalledTimes(1));
      const newTerminalRef = makeTerminalRef();
      if (replacement === "current") {
        terminalRef.current = newTerminalRef.current;
      } else {
        rerender({ sessionId: "s1", terminalRef: newTerminalRef, onAfterPaste });
      }

      first.resolve({ success: true, path: "uploaded/notes.txt" });
      await pending;

      expect(sendRemoteInputRaw).toHaveBeenCalledExactlyOnceWith("s1", "@uploaded/notes.txt ");
      expect(onAfterPaste).not.toHaveBeenCalled();
      expect(oldTerminal?.focus).not.toHaveBeenCalled();
      expect(newTerminalRef.current?.focus).not.toHaveBeenCalled();
    },
  );

  it("keeps the original input destination after unmount without focusing its disposed terminal", async () => {
    const first = deferredUpload();
    relayUploadFile.mockImplementationOnce(() => first.promise);
    const { result, unmount } = renderPaste();
    const pending = result.current(makePasteEvent({ files: [textFile()] }));
    await waitFor(() => expect(relayUploadFile).toHaveBeenCalledTimes(1));
    unmount();

    first.resolve({ success: true, path: "uploaded/notes.txt" });
    await pending;

    expect(sendRemoteInputRaw).toHaveBeenCalledExactlyOnceWith("s1", "@uploaded/notes.txt ");
    expect(onAfterPaste).not.toHaveBeenCalled();
    expect(terminalRef.current?.focus).not.toHaveBeenCalled();
  });
});
