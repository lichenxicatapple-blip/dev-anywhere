import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProcessArgv } from "#src/common/managed-session-process.js";
import { readParentProcessId } from "#src/common/process-ancestry.js";
import { parseWindowsCommandLine, readWindowsProcess } from "#src/common/windows-process.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

function queryResult(record: unknown, status = 0) {
  return {
    pid: 900,
    status,
    signal: null,
    stdout: JSON.stringify(record),
    stderr: "",
    output: [],
  };
}

describe("Windows process query", () => {
  it("uses one bounded CIM query and validates its structured identity", () => {
    vi.mocked(spawnSync).mockReturnValue(
      queryResult({ ProcessId: 123, ParentProcessId: 42, CommandLine: "node.exe worker.js" }),
    );
    expect(readWindowsProcess(123)).toEqual({
      pid: 123,
      parentPid: 42,
      commandLine: "node.exe worker.js",
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("ProcessId = 123")],
      expect.objectContaining({ timeout: 5_000, windowsHide: true }),
    );
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("-Property ProcessId,ParentProcessId,CommandLine"),
      ]),
    );
  });

  it.each([
    null,
    {},
    { ProcessId: 999, ParentProcessId: 42, CommandLine: "node.exe" },
    { ProcessId: 123, ParentProcessId: -1, CommandLine: "node.exe" },
    { ProcessId: 123, ParentProcessId: 42 },
  ])("does not identify an absent or malformed process: %j", (record) => {
    vi.mocked(spawnSync).mockReturnValue(queryResult(record));
    expect(readWindowsProcess(123)).toBeNull();
  });

  it("does not trust output from a failed query", () => {
    vi.mocked(spawnSync).mockReturnValue(
      queryResult({ ProcessId: 123, ParentProcessId: 42, CommandLine: "node.exe" }, 1),
    );
    expect(readWindowsProcess(123)).toBeNull();
  });

  it("rejects invalid process ids before invoking PowerShell", () => {
    for (const pid of [-1, 0, NaN, 1.5]) expect(readWindowsProcess(pid)).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("shares Windows command-line and parent lookup without falling through to ps", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(spawnSync).mockReturnValue(
      queryResult({
        ProcessId: 123,
        ParentProcessId: 42,
        CommandLine: String.raw`"C:\Program Files\nodejs\node.exe" "C:\用户\工作 空间\worker.js"`,
      }),
    );
    expect(readProcessArgv(123)).toEqual([
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`C:\用户\工作 空间\worker.js`,
    ]);
    expect(readParentProcessId(123)).toBe(42);
    expect(vi.mocked(spawnSync).mock.calls.every(([command]) => command === "powershell.exe")).toBe(
      true,
    );
  });

  it("keeps unavailable argv unknown even when a parent pid is visible", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(spawnSync).mockReturnValue(
      queryResult({ ProcessId: 123, ParentProcessId: 42, CommandLine: null }),
    );
    expect(readProcessArgv(123)).toBeNull();
    expect(readParentProcessId(123)).toBe(42);
  });
});

describe("Windows native argument decoding", () => {
  it.each([
    ['node.exe "" next', ["node.exe", "", "next"]],
    [String.raw`node.exe a\\\b d"e f"g h`, ["node.exe", String.raw`a\\\b`, "de fg", "h"]],
    [String.raw`node.exe a\\\"b c d`, ["node.exe", String.raw`a\"b`, "c", "d"]],
    [String.raw`node.exe a\\\\"b c" d e`, ["node.exe", String.raw`a\\b c`, "d", "e"]],
    [String.raw`node.exe "C:\folder with spaces\\" next`, ["node.exe", "C:\\folder with spaces\\", "next"]],
    [String.raw`node.exe C:\folder\ next`, ["node.exe", "C:\\folder\\", "next"]],
    [String.raw`node.exe "a""b"`, ["node.exe", 'a"b']],
  ])("decodes %s", (command, expected) => {
    expect(parseWindowsCommandLine(command)).toEqual(expected);
  });

  it("rejects empty or incomplete command lines for process identification", () => {
    expect(parseWindowsCommandLine(" \t ")).toBeNull();
    expect(parseWindowsCommandLine('node.exe "unfinished')).toBeNull();
  });
});
