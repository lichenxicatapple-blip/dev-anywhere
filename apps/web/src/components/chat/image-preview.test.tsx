import type { ReactNode } from "react";
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

vi.mock("react-zoom-pan-pinch", () => ({
  TransformWrapper: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-transform-wrapper">{children}</div>
  ),
  TransformComponent: ({
    children,
    wrapperClass,
    contentClass,
  }: {
    children?: ReactNode;
    wrapperClass?: string;
    contentClass?: string;
  }) => (
    <div className={wrapperClass}>
      <div className={`react-transform-component ${contentClass ?? ""}`}>{children}</div>
    </div>
  ),
}));

import { ImagePreviewProvider, useImagePreview } from "./image-preview";

afterEach(cleanup);

function PreviewProbe({ path }: { path: string }) {
  const { openImagePreview } = useImagePreview();
  return (
    <button type="button" onClick={() => openImagePreview(path)}>
      open preview
    </button>
  );
}

describe("ImagePreviewProvider", () => {
  beforeEach(() => {
    requestRemoteFileUrl.mockReset();
    toastLoading.mockReset();
    toastLoading.mockReturnValue("loading-id");
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("focuses the preview surface instead of highlighting an action on open", async () => {
    requestRemoteFileUrl.mockResolvedValueOnce({
      success: false,
      error: "missing",
    });

    render(
      <ImagePreviewProvider sessionId="s1">
        <PreviewProbe path="docs/assets/readme-mobile-create.png" />
      </ImagePreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "open preview" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "复制路径" }));
  });

  it("does not report the image as loaded until the browser image load event fires", async () => {
    const path =
      "/Users/catli/MyApps/dev-anywhere/.dev-anywhere/clipboard/a-very-long-directory-name/another-very-long-directory-name/pasted-image-with-a-long-name.png";
    requestRemoteFileUrl.mockResolvedValueOnce({
      success: true,
      url: "https://example.test/slow-image.png",
      path,
    });

    render(
      <ImagePreviewProvider sessionId="s1">
        <PreviewProbe path={path} />
      </ImagePreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "open preview" }));

    await waitFor(() => expect(requestRemoteFileUrl).toHaveBeenCalledWith("s1", path, "inline"));
    const img = await screen.findByRole("img");
    const meta = document.querySelector('[data-slot="image-preview-meta"]');
    const loading = document.querySelector('[data-slot="image-preview-loading"]');

    expect((img as HTMLImageElement).dataset.loaded).toBe("false");
    expect(meta?.textContent).toBe("正在加载图片...");
    expect(loading?.textContent).toContain("正在加载图片...");
    expect(screen.queryByText("图片已加载")).toBeNull();

    fireEvent.load(img);

    await waitFor(() => expect(meta?.textContent).toBe("图片已加载"));
    expect((img as HTMLImageElement).dataset.loaded).toBe("true");
  });
});
