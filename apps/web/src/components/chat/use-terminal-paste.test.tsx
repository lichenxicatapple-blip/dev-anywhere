import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import type { ClipboardEvent, RefObject } from "react";

const {
  sendRemoteInputRaw,
  uploadClipboardImageFromPaste,
  uploadFileAndShowToast,
  toastLoading,
  toastError,
  toastSuccess,
  toastDismiss,
  relayUploadFile,
} = vi.hoisted(() => ({
  sendRemoteInputRaw: vi.fn(),
  uploadClipboardImageFromPaste: vi.fn(),
  uploadFileAndShowToast: vi.fn(),
  toastLoading: vi.fn(() => "toast-id"),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastDismiss: vi.fn(),
  relayUploadFile: vi.fn(),
}));

vi.mock("@/lib/ansi-keys", () => ({ sendRemoteInputRaw }));
vi.mock("@/lib/clipboard-image-upload", () => ({ uploadClipboardImageFromPaste }));
vi.mock("@/lib/file-upload-payload", () => ({ uploadFileAndShowToast }));
vi.mock("@/components/toast", () => ({
  toast: {
    loading: toastLoading,
    error: toastError,
    success: toastSuccess,
    dismiss: toastDismiss,
  },
}));
vi.mock("@/hooks/use-relay-setup", () => ({
  // 真值在每个测试里通过 setRelay() 替换; 默认给个最小可用对象, 防 import 期 undefined.
  relayClientRef: { uploadFile: relayUploadFile },
}));

import { useTerminalPaste } from "./use-terminal-paste";
import * as relaySetup from "@/hooks/use-relay-setup";

function setRelay(value: unknown): void {
  // relayClientRef 是导出的可变 binding, hook 内部读 module-level 引用,
  // 测试需要直接覆盖. 这里走 Object.defineProperty 是因为 vi.mock 给的 binding 在
  // strict mode 下不是 writable.
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
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const clipboardData = {
    files: (opts.files ?? []) as unknown as FileList,
    items: (opts.items ?? []) as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
  return {
    clipboardData,
    preventDefault,
    stopPropagation,
  } as unknown as ClipboardEvent<HTMLDivElement>;
}

function imageFile(name = "shot.png", type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function textFile(name = "notes.txt", type = "text/plain"): File {
  return new File([new Uint8Array([0x41, 0x42, 0x43])], name, { type });
}

function makeTerminalRef(): RefObject<Terminal | null> {
  return { current: { focus: vi.fn() } as unknown as Terminal };
}

describe("useTerminalPaste", () => {
  const onAfterPaste = vi.fn();
  let terminalRef: RefObject<Terminal | null>;

  beforeEach(() => {
    sendRemoteInputRaw.mockReset();
    uploadClipboardImageFromPaste.mockReset();
    uploadFileAndShowToast.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("toast-id");
    toastError.mockReset();
    toastSuccess.mockReset();
    toastDismiss.mockReset();
    onAfterPaste.mockReset();
    terminalRef = makeTerminalRef();
    setRelay({ uploadFile: relayUploadFile });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function callHandler(event: ClipboardEvent<HTMLDivElement>): Promise<void> {
    const { result } = renderHook(() =>
      useTerminalPaste({ sessionId: "s1", terminalRef, onAfterPaste }),
    );
    return result.current(event);
  }

  it("uploads a pasted image and sends @path as remote input", async () => {
    uploadClipboardImageFromPaste.mockResolvedValueOnce({
      pathMention: "@.dev-anywhere/clipboard/s1/shot.png ",
    });
    const file = imageFile();
    const event = makePasteEvent({
      files: [file],
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    });

    await callHandler(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(uploadClipboardImageFromPaste).toHaveBeenCalledTimes(1);
    expect(uploadFileAndShowToast).not.toHaveBeenCalled();
    expect(sendRemoteInputRaw).toHaveBeenCalledWith("s1", "@.dev-anywhere/clipboard/s1/shot.png ");
    expect(onAfterPaste).toHaveBeenCalled();
  });

  it("does nothing when image upload returns null (e.g. extraction failed silently)", async () => {
    uploadClipboardImageFromPaste.mockResolvedValueOnce(null);
    const file = imageFile();
    const event = makePasteEvent({
      files: [file],
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    });

    await callHandler(event);

    expect(uploadClipboardImageFromPaste).toHaveBeenCalled();
    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
    expect(onAfterPaste).not.toHaveBeenCalled();
  });

  it("surfaces image upload errors via toast and does not send to PTY", async () => {
    uploadClipboardImageFromPaste.mockRejectedValueOnce(new Error("network broken"));
    const file = imageFile();
    const event = makePasteEvent({
      files: [file],
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    });

    await callHandler(event);

    expect(toastError).toHaveBeenCalledWith("network broken", { id: expect.any(String) });
    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
    expect(onAfterPaste).not.toHaveBeenCalled();
  });

  it("uploads a pasted non-image file and sends @path as remote input", async () => {
    uploadFileAndShowToast.mockResolvedValueOnce(".dev-anywhere/uploads/s1/notes.txt");
    const file = textFile();
    const event = makePasteEvent({ files: [file] });

    await callHandler(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(uploadFileAndShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", file }),
    );
    expect(uploadClipboardImageFromPaste).not.toHaveBeenCalled();
    expect(sendRemoteInputRaw).toHaveBeenCalledWith("s1", "@.dev-anywhere/uploads/s1/notes.txt ");
    expect(onAfterPaste).toHaveBeenCalled();
  });

  it("does not send anything when non-image upload returns null", async () => {
    uploadFileAndShowToast.mockResolvedValueOnce(null);
    const event = makePasteEvent({ files: [textFile()] });

    await callHandler(event);

    expect(uploadFileAndShowToast).toHaveBeenCalled();
    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
    expect(onAfterPaste).not.toHaveBeenCalled();
  });

  // 关键不回归: 没 file 时必须放行让 xterm 默认 paste 接管 (粘贴文本走 OSC 52),
  // 一旦 preventDefault 文本粘贴会从此失效。
  it("ignores text-only paste so xterm default paste handler can run", async () => {
    const event = makePasteEvent({ files: [], items: [] });

    await callHandler(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(uploadClipboardImageFromPaste).not.toHaveBeenCalled();
    expect(uploadFileAndShowToast).not.toHaveBeenCalled();
    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
  });

  it("toast.error and abort when relay is not connected", async () => {
    setRelay(null);
    const event = makePasteEvent({ files: [textFile()] });

    await callHandler(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("请先连接开发机");
    expect(uploadFileAndShowToast).not.toHaveBeenCalled();
    expect(sendRemoteInputRaw).not.toHaveBeenCalled();
  });

  // 仅有非 image file (没 image item) 时: 走普通文件上传, 不会误判成 image 路径。
  it("prefers image branch when both image and non-image files coexist", async () => {
    uploadClipboardImageFromPaste.mockResolvedValueOnce({
      pathMention: "@.dev-anywhere/clipboard/s1/shot.png ",
    });
    const img = imageFile();
    const txt = textFile();
    const event = makePasteEvent({
      files: [txt, img],
      items: [
        { kind: "file", type: txt.type, getAsFile: () => txt },
        { kind: "file", type: img.type, getAsFile: () => img },
      ],
    });

    await callHandler(event);

    expect(uploadClipboardImageFromPaste).toHaveBeenCalled();
    expect(uploadFileAndShowToast).not.toHaveBeenCalled();
  });
});
