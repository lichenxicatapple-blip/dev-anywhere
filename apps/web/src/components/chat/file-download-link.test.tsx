import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { requestRemoteFileUrl, toastLoading, toastSuccess, toastError } = vi.hoisted(() => ({
  requestRemoteFileUrl: vi.fn(),
  toastLoading: vi.fn(() => "loading-id"),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { requestRemoteFileUrl },
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
    requestRemoteFileUrl.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    toastSuccess.mockReset();
    toastError.mockReset();
    HTMLAnchorElement.prototype.click = vi.fn() as unknown as () => void;
  });

  function renderWithProvider(path: string) {
    return render(
      <FileDownloadProvider sessionId="s1">
        <DownloadProbe path={path} />
      </FileDownloadProvider>,
    );
  }

  it("triggers requestRemoteFileUrl with sessionId + path on click", async () => {
    requestRemoteFileUrl.mockResolvedValueOnce({
      success: true,
      url: "/api/remote-files/token-1",
      path: "docs/foo.md",
    });
    renderWithProvider("docs/foo.md");

    fireEvent.click(screen.getByRole("button", { name: "download" }));

    await waitFor(() =>
      expect(requestRemoteFileUrl).toHaveBeenCalledWith("s1", "docs/foo.md", "download"),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("已开始下载 docs/foo.md", { id: "loading-id" }),
    );
  });

  it("surfaces errorCode through describeControlError when proxy reports failure", async () => {
    requestRemoteFileUrl.mockResolvedValueOnce({
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
