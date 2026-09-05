import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findCodexActiveWriter, parseFirstPid } from "#src/common/codex-active-writer.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("Codex active writer probe", () => {
  it("leaves Windows owner discovery unknown without invoking unavailable lsof", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(findCodexActiveWriter("session-12345678")).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });
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
