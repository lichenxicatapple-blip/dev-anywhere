import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { download, openImagePreview, requestImagePreviewUrl } = vi.hoisted(() => ({
  download: vi.fn(),
  openImagePreview: vi.fn(),
  requestImagePreviewUrl: vi.fn(),
}));

vi.mock("./file-download-link", () => ({
  useFileDownload: () => ({ download }),
}));

vi.mock("./image-preview", () => ({
  useImagePreview: () => ({ openImagePreview, requestImagePreviewUrl }),
}));

import { UserMessageAttachments } from "./user-message-attachments";

afterEach(cleanup);

describe("UserMessageAttachments", () => {
  beforeEach(() => {
    download.mockReset();
    openImagePreview.mockReset();
    requestImagePreviewUrl.mockReset();
    requestImagePreviewUrl.mockImplementation(async (path: string) => ({
      url: `https://example.test/${encodeURIComponent(path)}`,
      path,
    }));
  });

  it("renders multiple images as a bounded horizontal gallery with contextual edge fades", async () => {
    const { container } = render(
      <UserMessageAttachments
        attachments={[
          { kind: "image", path: "/tmp/first image.png" },
          { kind: "image", path: "/tmp/second image.png" },
          { kind: "image", path: "/tmp/third image.png" },
        ]}
      />,
    );

    const gallery = container.querySelector<HTMLElement>('[data-slot="user-image-gallery"]');
    const scroller = container.querySelector<HTMLElement>(
      '[data-slot="user-image-gallery-scroller"]',
    );
    expect(gallery?.className).toContain("overflow-hidden");
    expect(scroller?.className).toContain("overflow-x-auto");
    expect(screen.getAllByRole("button", { name: /打开第 .* 张图片/ })).toHaveLength(3);

    Object.defineProperties(scroller!, {
      clientWidth: { configurable: true, value: 240 },
      scrollWidth: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(scroller!);
    expect(
      container
        .querySelector('[data-slot="user-image-gallery-fade-right"]')
        ?.getAttribute("data-visible"),
    ).toBe("true");
    expect(
      container
        .querySelector('[data-slot="user-image-gallery-fade-left"]')
        ?.getAttribute("data-visible"),
    ).toBe("false");

    scroller!.scrollLeft = 100;
    fireEvent.scroll(scroller!);
    expect(
      container
        .querySelector('[data-slot="user-image-gallery-fade-left"]')
        ?.getAttribute("data-visible"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "打开第 2 张图片" }));
    expect(openImagePreview).toHaveBeenCalledWith("/tmp/second image.png");
    await waitFor(() => expect(requestImagePreviewUrl).toHaveBeenCalledTimes(3));
  });

  it("renders one image as a compact thumbnail and keeps the normal preview action", async () => {
    const path = "/tmp/compact preview.png";
    const { container } = render(
      <UserMessageAttachments attachments={[{ kind: "image", path }]} />,
    );

    const gallery = container.querySelector<HTMLElement>('[data-slot="user-image-gallery"]');
    expect(gallery?.className).toContain("w-32");
    const thumbnail = screen.getByRole("button", { name: "打开图片" });
    expect(thumbnail.className).toContain("h-24");
    expect(thumbnail.className).toContain("w-32");
    fireEvent.click(thumbnail);
    expect(openImagePreview).toHaveBeenCalledWith(path);
    await waitFor(() => expect(requestImagePreviewUrl).toHaveBeenCalledWith(path));
  });

  it("renders a semantic file card without exposing its file name or path visually", () => {
    const path = "/private/uploads/customer secrets/final-report.pdf";
    const { container } = render(<UserMessageAttachments attachments={[{ kind: "file", path }]} />);

    expect(container.textContent).toContain("PDF 文件");
    expect(container.textContent).toContain("点按下载");
    expect(container.textContent).not.toContain("final-report.pdf");
    expect(container.textContent).not.toContain("/private/uploads");

    fireEvent.click(screen.getByRole("button", { name: "下载 final-report.pdf" }));
    expect(download).toHaveBeenCalledWith(path, { label: "PDF 文件" });
  });
});
