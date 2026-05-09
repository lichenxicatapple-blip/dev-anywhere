import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("uses homePath, not the active session cwd, as the select-mode base directory", async () => {
    render(
      <FilePathPicker
        mode="select"
        dirsOnly
        filter="/home/dev"
        onSelect={vi.fn()}
        title="选择下一级目录"
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

    const { getByRole, getByPlaceholderText } = render(
      <FilePathPicker
        mode="select"
        dirsOnly
        filter="/home/dev"
        onSelect={onSelect}
        onCreateDirectory={onCreateDirectory}
        title="选择下一级目录"
      />,
    );

    fireEvent.click(getByRole("button", { name: "新建目录" }));
    fireEvent.change(getByPlaceholderText("目录名称"), {
      target: { value: "new-project" },
    });
    fireEvent.click(getByRole("button", { name: "创建目录" }));

    await waitFor(() => {
      expect(onCreateDirectory).toHaveBeenCalledWith("/home/dev/new-project");
    });
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("/home/dev/new-project/");
    });
  });
});
