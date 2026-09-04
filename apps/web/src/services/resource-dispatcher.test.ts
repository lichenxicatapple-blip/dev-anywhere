import { beforeEach, describe, expect, it } from "vitest";
import type { CommandEntry } from "@dev-anywhere/shared";
import { useCommandStore } from "@/stores/command-store";
import { useFileStore } from "@/stores/file-store";
import { dispatchResourceMessage } from "./resource-dispatcher";

function command(name: string): CommandEntry {
  return { name, description: name, source: "test" };
}

describe("resource-dispatcher", () => {
  beforeEach(() => {
    useCommandStore.setState(useCommandStore.getInitialState(), true);
    useFileStore.setState(useFileStore.getInitialState(), true);
  });

  it("caches a scoped push without exposing it in another active session", () => {
    useCommandStore.getState().setActiveSession("s1");
    useCommandStore.getState().setSessionCommands("s1", [command("/s1")]);

    dispatchResourceMessage({
      type: "command_list_push",
      sessionId: "s2",
      commands: [command("/s2")],
    });

    expect(useCommandStore.getState().commands.map((entry) => entry.name)).toEqual(["/s1"]);
    expect(useCommandStore.getState().commandsBySessionId.s2[0].name).toBe("/s2");
  });

  it("updates the visible list when a scoped push belongs to the active session", () => {
    useCommandStore.getState().setActiveSession("s1");

    dispatchResourceMessage({
      type: "command_list_push",
      sessionId: "s1",
      commands: [command("/active")],
    });

    expect(useCommandStore.getState().commands.map((entry) => entry.name)).toEqual(["/active"]);
  });

  it("leaves requested directory responses to the requesting loader", () => {
    dispatchResourceMessage({
      type: "dir_list_response",
      requestId: "normal-list",
      path: "/workspace",
      includeHidden: false,
      entries: [{ name: "src", isDir: true }],
    });
    dispatchResourceMessage({
      type: "dir_list_response",
      requestId: "hidden-list",
      path: "/workspace",
      includeHidden: true,
      entries: [
        { name: ".git", isDir: true },
        { name: "src", isDir: true },
      ],
    });

    const state = useFileStore.getState();
    expect(state.tree.has("/workspace")).toBe(false);
    expect(state.treeWithHidden.has("/workspace")).toBe(false);
  });

  it("writes file-tree snapshots only to the normal cache", () => {
    useFileStore.getState().setDirEntries("/workspace", [{ name: ".env", isDir: false }], true);

    dispatchResourceMessage({
      type: "file_tree_push",
      groups: [{ path: "/workspace", entries: [{ name: "src", isDir: true }] }],
    });

    const state = useFileStore.getState();
    expect(state.tree.get("/workspace")).toEqual([{ name: "src", isDir: true }]);
    expect(state.treeWithHidden.get("/workspace")).toEqual([{ name: ".env", isDir: false }]);
  });
});
