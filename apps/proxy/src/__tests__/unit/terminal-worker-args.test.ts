import { describe, expect, it } from "vitest";
import { buildTerminalWorkerArgs } from "#src/serve/terminal-worker-spawner.js";
import { parseTerminalWorkerCliArgs } from "#src/terminal-worker-args.js";

describe("terminal worker args", () => {
  it("passes the proxy profile before terminal worker positionals", () => {
    expect(
      buildTerminalWorkerArgs(
        {
          sessionId: "session-1",
          cwd: "/Users/catli",
          name: "~",
        },
        "local",
      ),
    ).toEqual(["--profile", "local", "session-1", "/Users/catli", "~"]);
  });

  it("parses a profile-prefixed terminal worker invocation", () => {
    expect(
      parseTerminalWorkerCliArgs(["--profile", "local", "session-1", "/Users/catli", "~"]),
    ).toEqual({
      sessionId: "session-1",
      cwd: "/Users/catli",
      name: "~",
    });
  });

  it("keeps option-looking terminal names as positional values", () => {
    expect(
      parseTerminalWorkerCliArgs(["--profile=local", "session-1", "/Users/catli", "--profile"]),
    ).toEqual({
      sessionId: "session-1",
      cwd: "/Users/catli",
      name: "--profile",
    });
  });
});
