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

import { FileDownloadProvider, useFileDownload } from "./file-download-link";

afterEach(cleanup);

function DownloadProbe({ path }: { path: string }) {
  const { download } = useFileDownload();
  return (
    <button type="button" onClick={() => download(path)}>
      download
    </button>
  );
}

describe("FileDownloadProvider", () => {
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

  function renderWithProvider(path: string) {
    return render(
      <FileDownloadProvider sessionId="s1">
        <DownloadProbe path={path} />
      </FileDownloadProvider>,
    );
  }

  it("triggers requestFileDownload with sessionId + path on click", async () => {
    requestFileDownload.mockResolvedValueOnce({
      success: true,
      mimeType: "text/plain",
      dataBase64: Buffer.from("hi").toString("base64"),
      size: 2,
      path: "docs/foo.md",
    });
    renderWithProvider("docs/foo.md");

    fireEvent.click(screen.getByRole("button", { name: "download" }));

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
    renderWithProvider("README.md");

    fireEvent.click(screen.getByRole("button", { name: "download" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("下载失败：README.md（文件不存在）", {
        id: "loading-id",
      }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
