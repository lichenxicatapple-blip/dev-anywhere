import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { requestFileDownload, toastLoading, toastSuccess, toastError } = vi.hoisted(() => ({
  requestFileDownload: vi.fn(),
  toastLoading: vi.fn(() => "loading-id"),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { requestFileDownload },
}));

vi.mock("@/components/toast", () => ({
  toast: {
    loading: toastLoading,
    success: toastSuccess,
    error: toastError,
  },
}));

import { FileDownloadLinks, FileDownloadProvider } from "./file-download-link";

afterEach(cleanup);

describe("FileDownloadLinks", () => {
  beforeEach(() => {
    requestFileDownload.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    toastSuccess.mockReset();
    toastError.mockReset();
    URL.createObjectURL = vi.fn().mockReturnValue("blob:fake");
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn() as unknown as () => void;
  });

  function renderWithProvider(text: string) {
    return render(
      <FileDownloadProvider sessionId="s1">
        <FileDownloadLinks text={text} />
      </FileDownloadProvider>,
    );
  }

  it("renders nothing when text contains no recognizable file paths", () => {
    const { container } = renderWithProvider("hello world");
    expect(container.querySelector('[data-slot="file-download-links"]')).toBeNull();
  });

  it("renders one button per file path, skipping image paths (image-preview claims them)", () => {
    renderWithProvider("see README.md and shot.png and ./build/out.tar.gz");
    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.textContent?.trim());
    expect(labels).toContain("README.md");
    expect(labels).toContain("./build/out.tar.gz");
    expect(labels).not.toContain("shot.png");
  });

  it("triggers requestFileDownload with sessionId + path on click", async () => {
    requestFileDownload.mockResolvedValueOnce({
      success: true,
      mimeType: "text/plain",
      dataBase64: Buffer.from("hi").toString("base64"),
      size: 2,
      path: "docs/foo.md",
    });
    renderWithProvider("look at docs/foo.md");

    fireEvent.click(screen.getByRole("button", { name: /docs\/foo\.md/ }));

    await waitFor(() => expect(requestFileDownload).toHaveBeenCalledWith("s1", "docs/foo.md"));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("已下载 docs/foo.md", { id: "loading-id" }),
    );
  });

  it("surfaces errorCode through describeControlError when proxy reports failure", async () => {
    requestFileDownload.mockResolvedValueOnce({
      success: false,
      error: "ENOENT: no such file",
      errorCode: "PATH_NOT_FOUND",
    });
    renderWithProvider("missing README.md ?");

    fireEvent.click(screen.getByRole("button", { name: /README\.md/ }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("下载失败：README.md（文件不存在）", {
        id: "loading-id",
      }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
