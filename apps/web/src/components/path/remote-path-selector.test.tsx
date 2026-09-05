import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({ coarse: false, deviceKind: "desktop" }));

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => media.coarse,
}));

vi.mock("@/lib/client-device", () => ({
  describeCurrentClientDevice: () => ({ deviceKind: media.deviceKind }),
}));

vi.mock("@/components/chat/file-path-picker", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  const MockFilePathPicker = forwardRef<
    { handleKey: (event: React.KeyboardEvent) => boolean },
    {
      filter: string;
      placement?: "floating" | "inline";
      dirsOnly?: boolean;
      fileExtensions?: readonly string[];
      includeHidden?: boolean;
      autoHighlightFirst?: boolean;
      onNavigate?: (path: string) => void;
      onSelect: (path: string) => void;
      onSelectCurrentDirectory?: (path: string) => void;
      onCreateDirectory?: (path: string) => Promise<string | null>;
    }
  >(function MockFilePathPicker(props, ref) {
    useImperativeHandle(ref, () => ({
      handleKey: (event) => event.key === "ArrowDown",
    }));

    return (
      <div
        data-slot="mock-file-path-picker"
        data-filter={props.filter}
        data-placement={props.placement}
        data-dirs-only={String(Boolean(props.dirsOnly))}
        data-include-hidden={String(Boolean(props.includeHidden))}
        data-file-extensions={props.fileExtensions?.join(",") ?? ""}
        data-auto-highlight-first={String(props.autoHighlightFirst !== false)}
        data-has-current-directory={String(Boolean(props.onSelectCurrentDirectory))}
        data-has-create-directory={String(Boolean(props.onCreateDirectory))}
      >
        <button type="button" onClick={() => props.onNavigate?.("/home/dev/project/")}>
          navigate directory
        </button>
        <button type="button" onClick={() => props.onSelect("/home/dev/project/index.html")}>
          select file
        </button>
        {props.onSelectCurrentDirectory ? (
          <>
            <button
              type="button"
              onClick={() => props.onSelectCurrentDirectory?.("/home/dev/project/")}
            >
              select current directory
            </button>
            <button type="button" onClick={() => props.onSelectCurrentDirectory?.("./relative/")}>
              select relative current directory
            </button>
          </>
        ) : null}
        <button type="button" onClick={() => props.onNavigate?.("./relative/")}>
          navigate relative directory
        </button>
        <button type="button" onClick={() => props.onSelect("./relative/file")}>
          select relative file
        </button>
        <button type="button" onClick={() => props.onSelect("C:\\Tools\\claude.exe")}>
          select Windows file
        </button>
        <button type="button" onClick={() => props.onNavigate?.("\\\\server\\tools\\")}>
          navigate UNC directory
        </button>
      </div>
    );
  });
  return { FilePathPicker: MockFilePathPicker };
});

import { RemotePathSelector, type RemotePathSelectionKind } from "./remote-path-selector";
import { useFileStore } from "@/stores/file-store";

function renderSelector(
  options: {
    value?: string;
    selectionKind?: RemotePathSelectionKind;
    autoFocus?: boolean;
    name?: string;
    includeHidden?: boolean;
    fileExtensions?: readonly string[];
    onValueChange?: (path: string) => void;
  } = {},
) {
  const onValueChange = options.onValueChange ?? vi.fn();
  const result = render(
    <RemotePathSelector
      value={options.value ?? ""}
      onValueChange={onValueChange}
      selectionKind={options.selectionKind ?? "file-or-directory"}
      autoFocus={options.autoFocus}
      name={options.name}
      includeHidden={options.includeHidden}
      fileExtensions={options.fileExtensions}
      label="远程路径"
      placeholder="选择远程路径"
    />,
  );
  return { ...result, onValueChange };
}

function browser(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-slot="mock-file-path-picker"]');
  if (!element) throw new Error("Expected the remote path browser to be open");
  return element;
}

describe("RemotePathSelector", () => {
  beforeEach(() => {
    media.coarse = false;
    media.deviceKind = "desktop";
    useFileStore.setState({
      tree: new Map(),
      treeWithHidden: new Map(),
      cwd: "/home/dev/project",
      homePath: "/home/dev",
      agentCli: null,
    });
  });

  afterEach(() => cleanup());

  it("renders a real text input on fine-pointer devices and supports typing and keyboard input", () => {
    const onKeyDown = vi.fn();
    const onValueChange = vi.fn();
    const { container, getByRole } = render(
      <RemotePathSelector
        value=""
        onValueChange={onValueChange}
        selectionKind="directory"
        label="工作目录"
        onKeyDown={onKeyDown}
      />,
    );
    const input = getByRole("textbox", { name: "工作目录" });

    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("data-path-control", "input");
    expect(container.querySelector('[data-slot="mock-file-path-picker"]')).toBeNull();

    fireEvent.focus(input);
    expect(browser(container)).toHaveAttribute("data-placement", "floating");

    fireEvent.change(input, { target: { value: "/opt/tools" } });
    expect(onValueChange).toHaveBeenCalledWith("/opt/tools");
    expect(browser(container)).toHaveAttribute("data-filter", "/opt/tools");

    fireEvent.click(getByRole("button", { name: "navigate directory" }));
    expect(input).toHaveValue("/opt/tools");
    expect(browser(container)).toHaveAttribute("data-filter", "/home/dev/project/");
    expect(onValueChange).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "F2" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("focuses the fine-pointer input and opens its browser when autoFocus is set", async () => {
    const { container, getByRole } = renderSelector({ autoFocus: true });
    const input = getByRole("textbox", { name: "远程路径" });

    await waitFor(() => expect(input).toHaveFocus());
    expect(browser(container)).toHaveAttribute("data-placement", "floating");
  });

  it("uses only a button and hidden form value without auto-opening on coarse pointers", () => {
    media.coarse = true;
    const { container, getByRole, queryByRole } = renderSelector({
      autoFocus: true,
      name: "remotePath",
      value: "/home/dev/site",
    });

    const control = getByRole("button", { name: "远程路径" });
    expect(control).toHaveAttribute("data-path-control", "button");
    expect(queryByRole("textbox")).toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.querySelector('input[type="hidden"][name="remotePath"]')).toHaveValue(
      "/home/dev/site",
    );
    expect(container.querySelector('[data-slot="mock-file-path-picker"]')).toBeNull();
    expect(control).not.toHaveFocus();

    fireEvent.click(control);
    expect(browser(container)).toHaveAttribute("data-placement", "inline");
    expect(browser(container)).toHaveAttribute("data-auto-highlight-first", "false");
  });

  it("uses the touch path control for a phone even before pointer media settles", () => {
    media.deviceKind = "phone";

    const { container, getByRole, queryByRole } = renderSelector();

    expect(getByRole("button", { name: "远程路径" })).toHaveAttribute(
      "data-path-control",
      "button",
    );
    expect(queryByRole("textbox")).toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it("lets an outside action finish before closing an inline picker", () => {
    media.coarse = true;
    const outsideAction = vi.fn();
    const { container, getByRole } = render(
      <>
        <RemotePathSelector
          value="/home/dev/site"
          onValueChange={vi.fn()}
          selectionKind="file-or-directory"
          label="远程路径"
        />
        <button type="button" onClick={outsideAction}>
          outside action
        </button>
      </>,
    );

    fireEvent.click(getByRole("button", { name: "远程路径" }));
    expect(browser(container)).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "outside action" }));

    expect(outsideAction).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-slot="mock-file-path-picker"]')).toBeNull();
  });

  it("navigates directories without committing and commits only a directory or file selection", () => {
    media.coarse = true;
    const onValueChange = vi.fn();
    const { container, getByRole } = renderSelector({ onValueChange });

    fireEvent.click(getByRole("button", { name: "远程路径" }));
    fireEvent.click(getByRole("button", { name: "navigate directory" }));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(browser(container)).toHaveAttribute("data-filter", "/home/dev/project/");

    fireEvent.click(getByRole("button", { name: "select current directory" }));
    expect(onValueChange).toHaveBeenCalledWith("/home/dev/project/");
    expect(container.querySelector('[data-slot="mock-file-path-picker"]')).toBeNull();

    fireEvent.click(getByRole("button", { name: "远程路径" }));
    fireEvent.click(getByRole("button", { name: "select file" }));
    expect(onValueChange).toHaveBeenLastCalledWith("/home/dev/project/index.html");
    expect(container.querySelector('[data-slot="mock-file-path-picker"]')).toBeNull();
  });

  it("forwards selection filters and exposes current-directory selection by selection kind", () => {
    media.coarse = true;
    const common = {
      value: "",
      onValueChange: vi.fn(),
      label: "远程路径",
      autoFocus: true,
      includeHidden: true,
      fileExtensions: [".html", ".htm"] as const,
    };
    const { container, getByRole, rerender } = render(
      <RemotePathSelector {...common} selectionKind="file" />,
    );
    fireEvent.click(getByRole("button", { name: "远程路径" }));

    expect(browser(container)).toHaveAttribute("data-include-hidden", "true");
    expect(browser(container)).toHaveAttribute("data-file-extensions", ".html,.htm");
    expect(browser(container)).toHaveAttribute("data-dirs-only", "false");
    expect(browser(container)).toHaveAttribute("data-has-current-directory", "false");

    rerender(<RemotePathSelector {...common} selectionKind="directory" />);
    expect(browser(container)).toHaveAttribute("data-dirs-only", "true");
    expect(browser(container)).toHaveAttribute("data-has-current-directory", "true");

    rerender(<RemotePathSelector {...common} selectionKind="file-or-directory" />);
    expect(browser(container)).toHaveAttribute("data-dirs-only", "false");
    expect(browser(container)).toHaveAttribute("data-has-current-directory", "true");
  });

  it("opens an existing file at its parent directory instead of filtering to itself", () => {
    media.coarse = true;
    const { container, getByRole } = renderSelector({
      value: "/opt/bin/claude",
      selectionKind: "file",
    });

    fireEvent.click(getByRole("button", { name: "远程路径" }));
    expect(browser(container)).toHaveAttribute("data-filter", "/opt/bin/");
  });

  it("ignores relative navigation and selection results", () => {
    media.coarse = true;
    const onValueChange = vi.fn();
    const { container, getByRole } = renderSelector({ onValueChange });

    fireEvent.click(getByRole("button", { name: "远程路径" }));
    const initialFilter = browser(container).getAttribute("data-filter");
    fireEvent.click(getByRole("button", { name: "navigate relative directory" }));
    expect(browser(container)).toHaveAttribute("data-filter", initialFilter);

    fireEvent.click(getByRole("button", { name: "select relative file" }));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(browser(container)).toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: "select relative current directory" }));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(browser(container)).toBeInTheDocument();
  });

  it.each([false, true])("accepts drive and UNC paths on coarse pointer %s", (coarse) => {
    media.coarse = coarse;
    useFileStore.setState({ homePath: "C:\\Users\\dev" });
    const { container, getByRole, onValueChange } = renderSelector({
      value: "C:\\Tools\\codex.exe",
      selectionKind: "file",
    });
    const control = getByRole(coarse ? "button" : "textbox", { name: "远程路径" });
    if (coarse) fireEvent.click(control);
    else fireEvent.focus(control);
    expect(browser(container)).toHaveAttribute("data-filter", "C:\\Tools\\");
    fireEvent.click(getByRole("button", { name: "navigate UNC directory" }));
    expect(browser(container)).toHaveAttribute("data-filter", "\\\\server\\tools\\");
    fireEvent.click(getByRole("button", { name: "select Windows file" }));
    expect(onValueChange).toHaveBeenCalledWith("C:\\Tools\\claude.exe");
  });

  it.each([
    ["/home/dev", "//home/dev/site", "/home/dev/site"],
    ["D:\\Projects", "/site", "D:\\site"],
    ["\\\\server\\share\\project", "/site", "\\\\server\\share\\site"],
  ])(
    "qualifies pasted root paths using remote Home %s before submission",
    (homePath, pasted, expected) => {
      useFileStore.setState({ homePath });
      const { container, getByRole, onValueChange } = renderSelector();
      const input = getByRole("textbox", { name: "远程路径" });
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: pasted } });
      expect(onValueChange).toHaveBeenLastCalledWith(expected);
      expect(browser(container)).toHaveAttribute("data-filter", expected);
    },
  );
});
