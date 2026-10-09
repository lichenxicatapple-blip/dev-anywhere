import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPreviewProvider, useMediaPreview } from "./media-preview";

const { requestRemoteFileUrl, download } = vi.hoisted(() => ({
  requestRemoteFileUrl: vi.fn(),
  download: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/hooks/use-relay-setup", () => ({ relayClientRef: { requestRemoteFileUrl } }));
vi.mock("@/lib/file-download-trigger", () => ({ triggerFileDownload: download }));

function Probe({ path = "D:/clips/demo.mp4" }: { path?: string }) {
  const { openMediaPreview } = useMediaPreview();
  return <button onClick={() => openMediaPreview(path)}>预览视频</button>;
}

function Fixture({
  active = true,
  sessionId = "s1",
  path,
}: {
  active?: boolean;
  sessionId?: string;
  path?: string;
}) {
  return (
    <MediaPreviewProvider sessionId={sessionId} active={active}>
      <Probe path={path} />
    </MediaPreviewProvider>
  );
}

describe("video preview", () => {
  beforeEach(() => {
    requestRemoteFileUrl.mockReset();
    requestRemoteFileUrl.mockResolvedValue({
      success: true,
      url: "/api/remote-files/video",
      path: "D:/clips/demo.mp4",
    });
    download.mockClear();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens a streaming player and releases playback and its URL when closed", async () => {
    render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
    fireEvent.click(screen.getByText("预览视频"));
    const video = await screen.findByLabelText("视频播放器");
    expect(requestRemoteFileUrl).toHaveBeenCalledWith("s1", "D:/clips/demo.mp4", "inline");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).toHaveAttribute("src", "/api/remote-files/video");
    expect(video).not.toHaveAttribute("autoplay");
    fireEvent.loadedMetadata(video);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByLabelText("关闭视频预览"));
    await waitFor(() => expect(screen.queryByLabelText("视频播放器")).toBeNull());
    expect(video).not.toHaveAttribute("src");
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });

  it("stops audio when a keepalive session becomes inactive and stays closed when returning", async () => {
    const { rerender } = render(<Fixture />);
    fireEvent.click(screen.getByText("预览视频"));
    const video = await screen.findByLabelText("视频播放器");
    rerender(<Fixture active={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(video).not.toHaveAttribute("src");
    rerender(<Fixture />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not reopen a closed preview after a slow URL request resolves", async () => {
    let resolve!: (value: { success: boolean; url: string }) => void;
    requestRemoteFileUrl.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<Fixture />);
    fireEvent.click(screen.getByText("预览视频"));
    fireEvent.click(screen.getByLabelText("关闭视频预览"));
    await act(async () => {
      resolve({ success: true, url: "/late.mp4" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the terminal preview callback stable across keepalive visibility changes", () => {
    const attachLinks = vi.fn();
    const detachLinks = vi.fn();
    function TerminalLinks() {
      const { openMediaPreview } = useMediaPreview();
      useEffect(() => {
        attachLinks(openMediaPreview);
        return detachLinks;
      }, [openMediaPreview]);
      return null;
    }
    const { rerender } = render(
      <MediaPreviewProvider sessionId="s1">
        <TerminalLinks />
      </MediaPreviewProvider>,
    );
    rerender(
      <MediaPreviewProvider sessionId="s1" active={false}>
        <TerminalLinks />
      </MediaPreviewProvider>,
    );
    rerender(
      <MediaPreviewProvider sessionId="s1">
        <TerminalLinks />
      </MediaPreviewProvider>,
    );
    expect(attachLinks).toHaveBeenCalledTimes(1);
    expect(detachLinks).not.toHaveBeenCalled();
  });

  it("offers download for unsupported video and requests a fresh URL on retry", async () => {
    render(<Fixture />);
    fireEvent.click(screen.getByText("预览视频"));
    const video = await screen.findByLabelText("视频播放器");
    Object.defineProperty(video, "error", { value: { code: 4 } });
    fireEvent.error(video);
    expect(screen.getByRole("alert")).toHaveTextContent("格式或编码");
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    await waitFor(() =>
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "s1", path: "D:/clips/demo.mp4" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(requestRemoteFileUrl).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requests a new URL for a different session instead of using the previous cache", async () => {
    const { rerender } = render(<Fixture />);
    fireEvent.click(screen.getByText("预览视频"));
    await screen.findByLabelText("视频播放器");
    rerender(<Fixture sessionId="s2" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("预览视频"));
    await screen.findByLabelText("视频播放器");
    expect(requestRemoteFileUrl).toHaveBeenLastCalledWith("s2", "D:/clips/demo.mp4", "inline");
  });

  it("resolves a reopened relative path again after the Shell changes directory", async () => {
    requestRemoteFileUrl
      .mockResolvedValueOnce({
        success: true,
        url: "/first.mp4",
        path: "/a/demo.mp4",
        expiresAt: Date.now() + 60_000,
      })
      .mockResolvedValueOnce({
        success: true,
        url: "/second.mp4",
        path: "/b/demo.mp4",
        expiresAt: Date.now() + 60_000,
      });
    render(<Fixture path="./demo.mp4" />);
    fireEvent.click(screen.getByText("预览视频"));
    expect(await screen.findByLabelText("视频播放器")).toHaveAttribute("src", "/first.mp4");
    fireEvent.click(screen.getByLabelText("关闭视频预览"));
    fireEvent.click(screen.getByText("预览视频"));
    await waitFor(() =>
      expect(screen.getByLabelText("视频播放器")).toHaveAttribute("src", "/second.mp4"),
    );
    expect(screen.getByText("/b/demo.mp4")).toBeVisible();
    expect(requestRemoteFileUrl).toHaveBeenCalledTimes(2);
    expect(requestRemoteFileUrl).toHaveBeenNthCalledWith(2, "s1", "./demo.mp4", "inline");
  });

  it("retries the resolved file instead of reinterpreting its original relative path", async () => {
    requestRemoteFileUrl
      .mockResolvedValueOnce({ success: true, url: "/first.mp4", path: "/a/demo.mp4" })
      .mockResolvedValueOnce({ success: true, url: "/retry.mp4", path: "/a/demo.mp4" });
    render(<Fixture path="./demo.mp4" />);
    fireEvent.click(screen.getByText("预览视频"));
    const video = await screen.findByLabelText("视频播放器");
    Object.defineProperty(video, "error", { value: { code: 2 } });
    fireEvent.error(video);
    expect(screen.getByRole("alert")).toHaveTextContent("视频加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(screen.getByLabelText("视频播放器")).toHaveAttribute("src", "/retry.mp4"),
    );
    expect(requestRemoteFileUrl).toHaveBeenCalledTimes(2);
    expect(requestRemoteFileUrl).toHaveBeenNthCalledWith(2, "s1", "/a/demo.mp4", "inline");
  });
});
