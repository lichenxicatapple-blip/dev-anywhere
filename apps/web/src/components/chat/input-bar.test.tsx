import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  uploadClipboardImage,
  uploadFile,
  sendEnvelope,
  toastError,
  toastLoading,
  toastDismiss,
} = vi.hoisted(() => ({
  uploadClipboardImage: vi.fn(),
  uploadFile: vi.fn(),
  sendEnvelope: vi.fn(),
  toastError: vi.fn(),
  toastLoading: vi.fn(() => "loading-id"),
  toastDismiss: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    uploadClipboardImage,
    uploadFile,
    sendEnvelope,
    sendControl: vi.fn(),
  },
  wsManagerRef: null,
}));

vi.mock("@/components/toast", () => ({
  toast: { error: toastError, loading: toastLoading, dismiss: toastDismiss },
}));

vi.mock("./input-menu", () => ({
  InputMenu: () => (
    <button type="button" aria-label="更多">
      更多
    </button>
  ),
}));

import { InputBar } from "./input-bar";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function dispatchImagePaste(target: HTMLElement, file: File): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      files: [file],
    },
  });
  fireEvent(target, event);
  return event;
}

describe("InputBar clipboard image paste", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    uploadClipboardImage.mockReset();
    uploadClipboardImage.mockResolvedValue({
      success: true,
      path: ".dev-anywhere/clipboard/s1/shot.png",
    });
    sendEnvelope.mockReset();
    toastError.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    toastDismiss.mockReset();
    uploadFile.mockReset();
    uploadFile.mockResolvedValue({
      sessionId: "s1",
      success: true,
      path: ".dev-anywhere/uploads/s1/notes.txt",
    });
    useChatStore.setState({
      bySessionId: {
        s1: { ...EMPTY_SLICE, inputDraft: "inspect " },
      },
    });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
  });

  it("uploads pasted images and inserts the returned file token into JSON input", async () => {
    const { getByLabelText } = render(<InputBar sessionId="s1" />);
    const textarea = getByLabelText("输入聊天消息") as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

    const event = dispatchImagePaste(textarea, file);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(uploadClipboardImage).toHaveBeenCalledWith("s1", {
        mimeType: "image/png",
        dataBase64: "AQID",
        fileName: "shot.png",
      });
    });
    await waitFor(() => {
      expect(textarea.value).toBe("inspect @.dev-anywhere/clipboard/s1/shot.png ");
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  // 上传 loading toast 在传输期间给用户存在反馈, 成功后立即消失避免持续打扰。
  it("shows a loading toast during paste upload and dismisses it on success", async () => {
    const upload = deferred<{ success: boolean; path: string }>();
    uploadClipboardImage.mockReturnValueOnce(upload.promise);
    const { getByLabelText } = render(<InputBar sessionId="s1" />);
    const textarea = getByLabelText("输入聊天消息") as HTMLTextAreaElement;
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

    dispatchImagePaste(textarea, file);
    await waitFor(() => expect(toastLoading).toHaveBeenCalledTimes(1));
    expect(toastDismiss).not.toHaveBeenCalled();

    upload.resolve({ success: true, path: ".dev-anywhere/clipboard/s1/shot.png" });
    await waitFor(() => expect(toastDismiss).toHaveBeenCalledWith("loading-id"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("replaces the loading toast with an error message when upload fails", async () => {
    uploadClipboardImage.mockRejectedValueOnce(new Error("network broken"));
    const { getByLabelText } = render(<InputBar sessionId="s1" />);
    const textarea = getByLabelText("输入聊天消息") as HTMLTextAreaElement;
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

    dispatchImagePaste(textarea, file);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("network broken", { id: "loading-id" }),
    );
    expect(toastDismiss).not.toHaveBeenCalled();
  });

  it("inserts uploaded image tokens into the latest draft after slow uploads", async () => {
    const upload = deferred<{ success: boolean; path: string }>();
    uploadClipboardImage.mockReturnValueOnce(upload.promise);
    const { getByLabelText } = render(<InputBar sessionId="s1" />);
    const textarea = getByLabelText("输入聊天消息") as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

    dispatchImagePaste(textarea, file);
    fireEvent.change(textarea, { target: { value: "inspect this screenshot " } });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    upload.resolve({ success: true, path: ".dev-anywhere/clipboard/s1/shot.png" });

    await waitFor(() => {
      expect(textarea.value).toBe("inspect this screenshot @.dev-anywhere/clipboard/s1/shot.png ");
    });
  });

  it("keeps slow image uploads scoped to the original session after switching sessions", async () => {
    const upload = deferred<{ success: boolean; path: string }>();
    uploadClipboardImage.mockReturnValueOnce(upload.promise);
    useChatStore.setState({
      bySessionId: {
        s1: { ...EMPTY_SLICE, inputDraft: "inspect " },
        s2: { ...EMPTY_SLICE, inputDraft: "new session " },
      },
    });
    useSessionStore.setState({
      sessions: [
        { sessionId: "s1", mode: "json", provider: "claude", state: "idle" },
        { sessionId: "s2", mode: "json", provider: "claude", state: "idle" },
      ],
    });
    const { getByLabelText, rerender } = render(<InputBar sessionId="s1" />);
    const textarea = getByLabelText("输入聊天消息") as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

    dispatchImagePaste(textarea, file);
    rerender(<InputBar sessionId="s2" />);
    const switchedTextarea = getByLabelText("输入聊天消息") as HTMLTextAreaElement;
    expect(switchedTextarea.value).toBe("new session ");
    upload.resolve({ success: true, path: ".dev-anywhere/clipboard/s1/shot.png" });

    await waitFor(() => {
      expect(useChatStore.getState().bySessionId.s1?.inputDraft).toBe(
        "inspect @.dev-anywhere/clipboard/s1/shot.png ",
      );
    });
    expect(useChatStore.getState().bySessionId.s2?.inputDraft).toBe("new session ");
    expect(switchedTextarea.value).toBe("new session ");
  });
});

describe("InputBar attach file picker", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    uploadFile.mockReset();
    uploadFile.mockResolvedValue({
      sessionId: "s1",
      success: true,
      path: ".dev-anywhere/uploads/s1/notes.txt",
    });
    toastError.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    toastDismiss.mockReset();
    useChatStore.setState({
      bySessionId: { s1: { ...EMPTY_SLICE, inputDraft: "see " } },
    });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
    });
  });

  it("uploads picked file and inserts the @<path> token at the cursor", async () => {
    const { container, getByLabelText } = render(<InputBar sessionId="s1" />);
    const textarea = getByLabelText("输入聊天消息") as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const input = container.querySelector(
      'input[data-slot="input-attach-file-input"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(uploadFile).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ fileName: "notes.txt", mimeType: "text/plain" }),
    );
    await waitFor(() =>
      expect(useChatStore.getState().bySessionId.s1?.inputDraft).toBe(
        "see @.dev-anywhere/uploads/s1/notes.txt ",
      ),
    );
    expect(toastDismiss).toHaveBeenCalledWith("loading-id");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows error toast when upload fails", async () => {
    uploadFile.mockResolvedValueOnce({ sessionId: "s1", success: false, error: "磁盘满" });
    const { container } = render(<InputBar sessionId="s1" />);
    const input = container.querySelector(
      'input[data-slot="input-attach-file-input"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "x.bin", { type: "application/octet-stream" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(useChatStore.getState().bySessionId.s1?.inputDraft).toBe("see ");
  });
});
