import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendControl } = vi.hoisted(() => ({
  sendControl: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { sendControl },
  wsManagerRef: null,
}));

import { FilePathPicker } from "./file-path-picker";
import { useFileStore } from "@/stores/file-store";

describe("FilePathPicker", () => {
  beforeEach(() => {
    sendControl.mockClear();
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
      expect(sendControl).toHaveBeenCalledWith({
        type: "dir_list_request",
        path: "/Users/admin",
      });
    });
    expect(sendControl).not.toHaveBeenCalledWith({
      type: "dir_list_request",
      path: "/Users",
    });
  });
});
