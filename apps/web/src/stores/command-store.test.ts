import { beforeEach, describe, expect, it } from "vitest";
import type { CommandEntry } from "@dev-anywhere/shared";
import { useCommandStore } from "./command-store";

function command(name: string): CommandEntry {
  return { name, description: name, source: "test" };
}

describe("command-store session scoping", () => {
  beforeEach(() => {
    useCommandStore.setState(useCommandStore.getInitialState(), true);
  });

  it("caches inactive session commands without replacing the active session", () => {
    const store = useCommandStore.getState();
    store.setActiveSession("s1");
    store.setSessionCommands("s1", [command("/s1")]);
    store.setSessionCommands("s2", [command("/s2")]);

    expect(useCommandStore.getState().commands.map((entry) => entry.name)).toEqual(["/s1"]);
    expect(useCommandStore.getState().commandsBySessionId.s2[0].name).toBe("/s2");

    useCommandStore.getState().setActiveSession("s2");
    expect(useCommandStore.getState().commands.map((entry) => entry.name)).toEqual(["/s2"]);
  });

  it("distinguishes an intentionally empty session snapshot from a missing cache", () => {
    const store = useCommandStore.getState();
    store.setSessionCommands("empty-session", []);

    store.setActiveSession("uncached-session");
    expect(useCommandStore.getState().commands).toEqual([]);

    useCommandStore.getState().setActiveSession("empty-session");
    expect(useCommandStore.getState().commands).toEqual([]);
  });

  it("clears every command snapshot when the selected proxy is forgotten", () => {
    const store = useCommandStore.getState();
    store.setActiveSession("s1");
    store.setSessionCommands("s1", [command("/s1")]);

    store.clear();

    expect(useCommandStore.getState()).toMatchObject({
      commands: [],
      lastUpdated: 0,
      activeSessionId: null,
      commandsBySessionId: {},
    });
  });
});
