import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { registerImagePreviewLinkProvider } from "@/lib/xterm-image-preview-links";

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

  it("sends a wrapped Windows home image link unchanged to the remote file API", async () => {
    const path = String.raw`~\AppData\Local\Temp\dev-anywhere\paste-HCPesk.png`;
    const prefix = "Viewed Image ";
    const lines = [prefix + path.slice(0, 30), path.slice(30)];
    let openPreview: (path: string) => void = () => undefined;
    function TerminalPreviewProbe() {
      openPreview = useImagePreview().openImagePreview;
      return null;
    }
    requestRemoteFileUrl.mockResolvedValueOnce({
      success: true,
      url: "https://example.test/paste-HCPesk.png",
      path: String.raw`C:\Users\liche\AppData\Local\Temp\dev-anywhere\paste-HCPesk.png`,
    });
    render(
      <ImagePreviewProvider sessionId="s1">
        <TerminalPreviewProbe />
      </ImagePreviewProvider>,
    );
    const terminal = {
      buffer: {
        active: {
          getLine: (index: number) =>
            lines[index] === undefined
              ? undefined
              : { isWrapped: index === 1, translateToString: () => lines[index] },
        },
      },
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const { provider } = registerImagePreviewLinkProvider(terminal as never, (value) =>
      openPreview(value),
    );

    act(() => {
      provider.provideLinks(2, (links) => {
        expect(links).toHaveLength(1);
        const link = links![0];
        expect(link.text).toBe(path);
        link.activate(new MouseEvent("click", { ctrlKey: true }), link.text);
      });
    });

    await waitFor(() => expect(requestRemoteFileUrl).toHaveBeenCalledWith("s1", path, "inline"));
    expect(requestRemoteFileUrl).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("img")).toHaveAttribute(
      "src",
      "https://example.test/paste-HCPesk.png",
    );
  });

  it("focuses the preview surface instead of highlighting an action on open", async () => {
    requestRemoteFileUrl.mockResolvedValueOnce({
      success: false,
      error: "missing",
    });

    render(
      <ImagePreviewProvider sessionId="s1">
        <PreviewProbe path="docs/assets/example-preview.png" />
      </ImagePreviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "open preview" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "复制路径" }));
    const close = screen.getByRole("button", { name: "关闭图片预览" });
    expect(close).toHaveClass("size-11");
    expect(close.querySelector('[data-slot="image-preview-close-visual"]')).toHaveClass("size-7");
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
    expect(screen.getByRole("button", { name: "复制图片" })).toBeDisabled();
    expect(meta?.textContent).toBe("正在加载图片...");
    expect(loading?.textContent).toContain("正在加载图片...");
    expect(screen.queryByText("图片已加载")).toBeNull();

    fireEvent.load(img);

    await waitFor(() => expect(meta?.textContent).toBe("图片已加载"));
    expect((img as HTMLImageElement).dataset.loaded).toBe("true");
    expect(screen.getByRole("button", { name: "复制图片" })).toBeEnabled();
  });
});
