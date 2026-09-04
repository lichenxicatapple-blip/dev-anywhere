import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FilePathPicker", () => {
  beforeEach(() => {
    requestDirectoryList.mockReset();
    requestDirectoryList.mockResolvedValue({
      path: "/home/dev",
      entries: [],
      includeHidden: false,
    });
    useFileStore.setState({
      tree: new Map(),
      treeWithHidden: new Map(),
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
        onNavigate={vi.fn()}
        title="picker-title-sentinel"
      />,
    );

    await waitFor(() => {
      expect(requestDirectoryList).toHaveBeenCalledWith("/home/dev", { includeHidden: false });
    });
    expect(requestDirectoryList).not.toHaveBeenCalledWith("/Users");
  });

  it("emits an absolute file path when select mode starts with an empty filter", () => {
    useFileStore.setState({
      tree: new Map([["/home/dev", [{ name: "claude", isDir: false }]]]),
    });
    const onSelect = vi.fn();
    const { baseElement } = render(
      <FilePathPicker mode="select" filter="" onSelect={onSelect} onNavigate={vi.fn()} />,
    );

    fireEvent.click(baseElement.querySelector('[data-entry-name="claude"]')!);

    expect(onSelect).toHaveBeenCalledWith("/home/dev/claude");
  });

  it("separates directory navigation from file selection", () => {
    useFileStore.setState({
      tree: new Map([
        [
          "/home/dev",
          [
            { name: "bin", isDir: true },
            { name: "claude", isDir: false },
          ],
        ],
      ]),
    });
    const onNavigate = vi.fn();
    const onSelect = vi.fn();
    const { baseElement } = render(
      <FilePathPicker mode="select" filter="" onNavigate={onNavigate} onSelect={onSelect} />,
    );

    fireEvent.click(baseElement.querySelector('[data-entry-name="bin"]')!);
    expect(onNavigate).toHaveBeenCalledWith("/home/dev/bin/");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(baseElement.querySelector('[data-entry-name="claude"]')!);
    expect(onSelect).toHaveBeenCalledWith("/home/dev/claude");
  });

  it("requests and caches an include-hidden directory listing separately", async () => {
    requestDirectoryList.mockResolvedValueOnce({
      path: "/home/dev",
      entries: [{ name: ".local", isDir: true }],
      includeHidden: true,
    });

    const { baseElement } = render(
      <FilePathPicker
        mode="select"
        filter=""
        includeHidden
        onSelect={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(requestDirectoryList).toHaveBeenCalledWith("/home/dev", { includeHidden: true });
    });
    await waitFor(() => {
      expect(baseElement.querySelector('[data-entry-name=".local"]')).toBeInTheDocument();
    });
    expect(useFileStore.getState().treeWithHidden.get("/home/dev")).toEqual([
      { name: ".local", isDir: true },
    ]);
    expect(useFileStore.getState().tree.has("/home/dev")).toBe(false);
  });

  it("keeps only parent navigation in the select-mode toolbar", () => {
    useFileStore.setState({
      tree: new Map([["/opt/tools", []]]),
    });
    const onNavigate = vi.fn();
    const { baseElement } = render(
      <FilePathPicker
        mode="select"
        filter="/opt/tools/"
        onNavigate={onNavigate}
        onSelect={vi.fn()}
      />,
    );

    expect(baseElement.querySelector('[data-slot="file-path-picker-home"]')).toBeNull();
    expect(baseElement.querySelector('[data-slot="file-path-picker-root"]')).toBeNull();

    fireEvent.click(baseElement.querySelector('[data-slot="file-path-picker-parent"]')!);
    expect(onNavigate).toHaveBeenLastCalledWith("/opt/");
  });

  it("keeps insert-mode selections relative to the session cwd", () => {
    useFileStore.setState({
      tree: new Map([["/home/dev/projects/sample-app", [{ name: "README.md", isDir: false }]]]),
    });
    const onSelect = vi.fn();
    const { baseElement } = render(<FilePathPicker mode="insert" filter="@" onSelect={onSelect} />);

    fireEvent.click(baseElement.querySelector('[data-entry-name="README.md"]')!);
    expect(onSelect).toHaveBeenCalledWith("README.md");
  });

  it("creates and selects a child directory when the current directory can be selected", async () => {
    const onCreateDirectory = vi.fn().mockResolvedValue("/home/dev/new-project");
    const onNavigate = vi.fn();
    const onSelectCurrentDirectory = vi.fn();

    const { baseElement } = render(
      <FilePathPicker
        mode="select"
        dirsOnly
        filter="/home/dev"
        onSelect={vi.fn()}
        onNavigate={onNavigate}
        onSelectCurrentDirectory={onSelectCurrentDirectory}
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
      expect(onSelectCurrentDirectory).toHaveBeenCalledWith("/home/dev/new-project/");
    });
    expect(onNavigate).not.toHaveBeenCalled();
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
        onNavigate={vi.fn()}
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

  it("groups parent navigation and directory actions in one toolbar", () => {
    useFileStore.setState({
      tree: new Map([["/home/dev/site", [{ name: "index.html", isDir: false }]]]),
      cwd: "/home/dev/projects/sample-app",
      homePath: "/home/dev",
      agentCli: null,
    });
    const onSelect = vi.fn();
    const { getByRole } = render(
      <FilePathPicker
        mode="select"
        filter="/home/dev/site/"
        fileExtensions={[".html", ".htm"]}
        onSelect={onSelect}
        onNavigate={vi.fn()}
        onSelectCurrentDirectory={onSelect}
        onCreateDirectory={vi.fn()}
        title="picker-title-sentinel"
      />,
    );

    const toolbar = getByRole("toolbar", { name: "路径操作" });
    const parentButton = getByRole("button", { name: "上一级" });
    const createButton = getByRole("button", { name: "新建目录" });
    const selectButton = getByRole("button", { name: "选定" });
    expect(toolbar).toContainElement(parentButton);
    expect(toolbar).toContainElement(createButton);
    expect(toolbar).toContainElement(selectButton);

    fireEvent.click(selectButton);
    expect(onSelect).toHaveBeenCalledWith("/home/dev/site/");
  });

  it("does not pre-highlight touch entries", () => {
    useFileStore.setState({
      treeWithHidden: new Map([["/home/dev/.local/bin", [{ name: "claude", isDir: false }]]]),
      cwd: "/home/dev",
      homePath: "/home/dev",
      agentCli: null,
    });
    const { baseElement } = render(
      <FilePathPicker
        mode="select"
        placement="inline"
        filter="/home/dev/.local/bin/claude"
        includeHidden
        autoHighlightFirst={false}
        onSelect={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    const fileEntry = baseElement.querySelector<HTMLElement>('[data-slot="file-entry"]');
    expect(fileEntry).not.toHaveClass("bg-[color-mix(in_srgb,var(--primary)_15%,transparent)]");
  });

  it.each([
    ["normal", false],
    ["hidden", true],
  ] as const)(
    "does not cache a failed %s directory response and can retry it",
    async (_label, includeHidden) => {
      requestDirectoryList
        .mockResolvedValueOnce({
          path: "/home/dev",
          entries: [],
          includeHidden,
          error: "permission denied",
          errorCode: "PATH_NOT_FOUND",
        })
        .mockResolvedValueOnce({
          path: "/home/dev",
          entries: [{ name: "index.html", isDir: false }],
          includeHidden,
        });

      const { baseElement } = render(
        <FilePathPicker
          mode="select"
          filter="/home/dev"
          fileExtensions={[".html"]}
          includeHidden={includeHidden}
          onSelect={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );

      await waitFor(() =>
        expect(
          baseElement.querySelector('[data-slot="file-path-picker-error"]'),
        ).toBeInTheDocument(),
      );
      const failedState = useFileStore.getState();
      const failedCache = includeHidden ? failedState.treeWithHidden : failedState.tree;
      expect(failedCache.has("/home/dev")).toBe(false);

      fireEvent.click(baseElement.querySelector('[data-slot="file-path-picker-retry"]')!);

      await waitFor(() =>
        expect(
          baseElement.querySelector('[data-slot="file-entry"][data-entry-name="index.html"]'),
        ).toBeInTheDocument(),
      );
      expect(requestDirectoryList).toHaveBeenCalledTimes(2);
      expect(requestDirectoryList).toHaveBeenLastCalledWith("/home/dev", { includeHidden });

      const state = useFileStore.getState();
      const targetCache = includeHidden ? state.treeWithHidden : state.tree;
      const otherCache = includeHidden ? state.tree : state.treeWithHidden;
      expect(targetCache.get("/home/dev")).toEqual([{ name: "index.html", isDir: false }]);
      expect(otherCache.has("/home/dev")).toBe(false);
    },
  );

  it.each([
    ["normal", false],
    ["hidden", true],
  ] as const)(
    "keeps an in-flight %s request usable after navigating A to B to A",
    async (_label, includeHidden) => {
      const requestA = deferred<{
        path: string;
        entries: Array<{ name: string; isDir: boolean }>;
        includeHidden: boolean;
      }>();
      const requestB = deferred<{
        path: string;
        entries: Array<{ name: string; isDir: boolean }>;
        includeHidden: boolean;
      }>();
      requestDirectoryList.mockImplementation((path: string) => {
        if (path === "/home/dev/a") return requestA.promise;
        if (path === "/home/dev/b") return requestB.promise;
        throw new Error(`unexpected path: ${path}`);
      });

      const onNavigate = vi.fn();
      const rendered = render(
        <FilePathPicker
          mode="select"
          filter="/home/dev/a/"
          includeHidden={includeHidden}
          onSelect={vi.fn()}
          onNavigate={onNavigate}
        />,
      );
      await waitFor(() => {
        expect(requestDirectoryList).toHaveBeenCalledWith("/home/dev/a", { includeHidden });
      });

      rendered.rerender(
        <FilePathPicker
          mode="select"
          filter="/home/dev/b/"
          includeHidden={includeHidden}
          onSelect={vi.fn()}
          onNavigate={onNavigate}
        />,
      );
      await waitFor(() => {
        expect(requestDirectoryList).toHaveBeenCalledWith("/home/dev/b", { includeHidden });
      });

      rendered.rerender(
        <FilePathPicker
          mode="select"
          filter="/home/dev/a/"
          includeHidden={includeHidden}
          onSelect={vi.fn()}
          onNavigate={onNavigate}
        />,
      );
      expect(
        requestDirectoryList.mock.calls.filter(([path]) => path === "/home/dev/a"),
      ).toHaveLength(1);

      await act(async () => {
        requestA.resolve({
          path: "/home/dev/a",
          entries: [{ name: "ready.html", isDir: false }],
          includeHidden,
        });
        await requestA.promise;
      });
      await waitFor(() => {
        expect(
          rendered.baseElement.querySelector('[data-entry-name="ready.html"]'),
        ).toBeInTheDocument();
      });

      const state = useFileStore.getState();
      const targetCache = includeHidden ? state.treeWithHidden : state.tree;
      const otherCache = includeHidden ? state.tree : state.treeWithHidden;
      expect(targetCache.get("/home/dev/a")).toEqual([{ name: "ready.html", isDir: false }]);
      expect(otherCache.has("/home/dev/a")).toBe(false);

      await act(async () => {
        requestB.resolve({ path: "/home/dev/b", entries: [], includeHidden });
        await requestB.promise;
      });
    },
  );
});
