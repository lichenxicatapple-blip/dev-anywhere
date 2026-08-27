import { describe, expect, it } from "vitest";
import { findCodexActiveWriter, parseFirstPid } from "#src/common/codex-active-writer.js";

describe("Codex active writer probe", () => {
  it("parses the first positive PID from lsof output", () => {
    expect(parseFirstPid("46559\n48679\n")).toBe(46559);
    expect(parseFirstPid("not-a-pid")).toBeNull();
    expect(parseFirstPid("0\n")).toBeNull();
  });

  it("rejects unsafe native session ids before constructing a lock path", () => {
    expect(findCodexActiveWriter("../../etc/passwd")).toBeNull();
    expect(findCodexActiveWriter("short")).toBeNull();
  });
});
