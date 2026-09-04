import { beforeEach, describe, expect, it } from "vitest";
import { useFileStore } from "./file-store";

describe("file-store directory caches", () => {
  beforeEach(() => {
    useFileStore.setState(useFileStore.getInitialState(), true);
  });

  it("updates normal and hidden directory trees independently", () => {
    const store = useFileStore.getState();
    store.setDirEntries("/workspace", [{ name: "src", isDir: true }]);
    store.setDirEntries(
      "/workspace",
      [
        { name: ".git", isDir: true },
        { name: "src", isDir: true },
      ],
      true,
    );

    expect(useFileStore.getState().tree.get("/workspace")).toEqual([{ name: "src", isDir: true }]);
    expect(useFileStore.getState().treeWithHidden.get("/workspace")).toEqual([
      { name: ".git", isDir: true },
      { name: "src", isDir: true },
    ]);
  });

  it("clears both directory caches", () => {
    const store = useFileStore.getState();
    store.setDirEntries("/workspace", [{ name: "src", isDir: true }]);
    store.setDirEntries("/workspace", [{ name: ".git", isDir: true }], true);
    store.setCwd("/workspace");

    useFileStore.getState().clearTree();

    expect(useFileStore.getState().tree.size).toBe(0);
    expect(useFileStore.getState().treeWithHidden.size).toBe(0);
    expect(useFileStore.getState().cwd).toBe("");
  });

  it("drops both directory caches when switching developers", () => {
    const store = useFileStore.getState();
    store.setDirEntries("/workspace", [{ name: "src", isDir: true }]);
    store.setDirEntries("/workspace", [{ name: ".git", isDir: true }], true);

    useFileStore.getState().prepareForProxySwitch();

    expect(useFileStore.getState().tree.size).toBe(0);
    expect(useFileStore.getState().treeWithHidden.size).toBe(0);
  });
});
