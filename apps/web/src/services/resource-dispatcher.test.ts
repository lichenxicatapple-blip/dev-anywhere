import { beforeEach, describe, expect, it } from "vitest";
import type { CommandEntry } from "@dev-anywhere/shared";
import { useCommandStore } from "@/stores/command-store";
import { useFileStore } from "@/stores/file-store";
import { dispatchResourceMessage } from "./resource-dispatcher";

function command(name: string): CommandEntry {
  return { name, description: name, source: "test" };
}

describe("resource-dispatcher command scoping", () => {
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

  it("continues to display legacy unscoped pushes", () => {
    useCommandStore.getState().setActiveSession("s1");

    dispatchResourceMessage({
      type: "command_list_push",
      commands: [command("/legacy")],
    });

    expect(useCommandStore.getState().commands.map((entry) => entry.name)).toEqual(["/legacy"]);
  });

  it("writes unsolicited resource snapshots to their specified session cache", () => {
    useCommandStore.getState().setActiveSession("s1");

    dispatchResourceMessage({
      type: "session_resources_response",
      sessionId: "s2",
      commands: [command("/late-s2")],
      groups: [],
    });

    expect(useCommandStore.getState().commands).toEqual([]);
    expect(useCommandStore.getState().commandsBySessionId.s2[0].name).toBe("/late-s2");
  });
});
