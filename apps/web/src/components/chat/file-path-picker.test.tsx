import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestDirectoryList } = vi.hoisted(() => ({
  requestDirectoryList: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { requestDirectoryList },
  wsManagerRef: null,
}));

import { FilePathPicker } from "./file-path-picker";
import { useFileStore } from "@/stores/file-store";

describe("FilePathPicker", () => {
  beforeEach(() => {
    requestDirectoryList.mockReset();
    requestDirectoryList.mockResolvedValue({ path: "/home/dev", entries: [] });
    useFileStore.setState({
      tree: new Map(),
      cwd: "/home/dev/projects/sample-app",
      homePath: "/home/dev",
      agentCli: null,
    });
  });

  afterEach(() => cleanup());

  it("uses homePath, not the active session cwd, as the select-mode base directory", async () => {
    render(
      <FilePathPicker
        mode="select"
        dirsOnly
        filter="/home/dev"
        onSelect={vi.fn()}
        title="picker-title-sentinel"
      />,
    );

    await waitFor(() => {
      expect(requestDirectoryList).toHaveBeenCalledWith("/home/dev");
    });
    expect(requestDirectoryList).not.toHaveBeenCalledWith("/Users");
  });

  it("creates a child directory from the select-mode directory picker", async () => {
    const onCreateDirectory = vi.fn().mockResolvedValue("/home/dev/new-project");
    const onSelect = vi.fn();

    const { baseElement } = render(
      <FilePathPicker
        mode="select"
        dirsOnly
        filter="/home/dev"
        onSelect={onSelect}
        onCreateDirectory={onCreateDirectory}
        title="picker-title-sentinel"
      />,
    );

    fireEvent.click(
      baseElement.querySelector('[data-slot="file-path-picker-create-directory-toggle"]')!,
    );
    fireEvent.change(
      baseElement.querySelector('[data-slot="file-path-picker-create-directory-name"]')!,
      {
        target: { value: "new-project" },
      },
    );
    fireEvent.click(
      baseElement.querySelector('[data-slot="file-path-picker-create-directory-submit"]')!,
    );

    await waitFor(() => {
      expect(onCreateDirectory).toHaveBeenCalledWith("/home/dev/new-project");
    });
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("/home/dev/new-project/");
    });
  });

  it("keeps directories navigable while filtering files to HTML", () => {
    useFileStore.setState({
      tree: new Map([
        [
          "/home/dev",
          [
            { name: "pages", isDir: true },
            { name: "home.html", isDir: false },
            { name: "legacy.HTM", isDir: false },
            { name: "styles.css", isDir: false },
          ],
        ],
      ]),
      cwd: "/home/dev/projects/sample-app",
      homePath: "/home/dev",
      agentCli: null,
    });

    const { baseElement } = render(
      <FilePathPicker
        mode="select"
        filter="/home/dev/"
        fileExtensions={[".html", ".htm"]}
        onSelect={vi.fn()}
      />,
    );

    expect(
      baseElement.querySelector('[data-slot="file-entry"][data-entry-name="pages"]'),
    ).toBeInTheDocument();
    expect(
      baseElement.querySelector('[data-slot="file-entry"][data-entry-name="home.html"]'),
    ).toBeInTheDocument();
    expect(
      baseElement.querySelector('[data-slot="file-entry"][data-entry-name="legacy.HTM"]'),
    ).toBeInTheDocument();
    expect(
      baseElement.querySelector('[data-slot="file-entry"][data-entry-name="styles.css"]'),
    ).not.toBeInTheDocument();
  });

  it("offers an explicit action for selecting the current folder", () => {
    useFileStore.setState({
      tree: new Map([["/home/dev/site", [{ name: "index.html", isDir: false }]]]),
      cwd: "/home/dev/projects/sample-app",
      homePath: "/home/dev",
      agentCli: null,
    });
    const onSelect = vi.fn();
    const { baseElement } = render(
      <FilePathPicker
        mode="select"
        filter="/home/dev/site/"
        fileExtensions={[".html", ".htm"]}
        onSelect={onSelect}
        onSelectCurrentDirectory={onSelect}
        title="picker-title-sentinel"
      />,
    );

    fireEvent.click(baseElement.querySelector('[data-slot="select-current-directory"]')!);
    expect(onSelect).toHaveBeenCalledWith("/home/dev/site/");
  });

  it("shows a retryable directory error instead of treating failures as an empty folder", async () => {
    requestDirectoryList
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({
        path: "/home/dev",
        entries: [{ name: "index.html", isDir: false }],
      });

    const { baseElement } = render(
      <FilePathPicker
        mode="select"
        filter="/home/dev"
        fileExtensions={[".html"]}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(baseElement.querySelector('[data-slot="file-path-picker-error"]')).toBeInTheDocument(),
    );
    fireEvent.click(baseElement.querySelector('[data-slot="file-path-picker-retry"]')!);

    await waitFor(() =>
      expect(
        baseElement.querySelector('[data-slot="file-entry"][data-entry-name="index.html"]'),
      ).toBeInTheDocument(),
    );
    expect(requestDirectoryList).toHaveBeenCalledTimes(2);
  });
});
