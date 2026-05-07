import { render, waitFor } from "@testing-library/react";
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
});
