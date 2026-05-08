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
    requestDirectoryList.mockResolvedValue({ path: "/Users/admin", entries: [] });
    useFileStore.setState({
      tree: new Map(),
      cwd: "/Users/admin/test_go",
      homePath: "/Users/admin",
      agentCli: null,
    });
  });

  it("uses homePath, not the active session cwd, as the select-mode base directory", async () => {
    render(
      <FilePathPicker
        mode="select"
        dirsOnly
        filter="/Users/admin"
        onSelect={vi.fn()}
        title="选择下一级目录"
      />,
    );

    await waitFor(() => {
      expect(requestDirectoryList).toHaveBeenCalledWith("/Users/admin");
    });
    expect(requestDirectoryList).not.toHaveBeenCalledWith("/Users");
  });

  it("creates a child directory from the select-mode directory picker", async () => {
    const onCreateDirectory = vi.fn().mockResolvedValue("/Users/admin/new-project");
    const onSelect = vi.fn();

    const { getByRole, getByPlaceholderText } = render(
      <FilePathPicker
        mode="select"
        dirsOnly
        filter="/Users/admin"
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
      expect(onCreateDirectory).toHaveBeenCalledWith("/Users/admin/new-project");
    });
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("/Users/admin/new-project/");
    });
  });
});
