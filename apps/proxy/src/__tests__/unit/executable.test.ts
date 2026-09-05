import { describe, expect, it, vi } from "vitest";
import {
  defaultShell,
  environmentValue,
  findExecutableCandidates,
  normalizeProcessEnvironment,
} from "#src/common/executable.js";

function windowsFiles(files: string[]) {
  const available = new Set(files.map((file) => file.toLowerCase()));
  return {
    platform: "win32" as const,
    cwd: "C:\\workspace",
    isExecutableFile: vi.fn((file: string) => available.has(file.toLowerCase())),
  };
}

describe("platform executable lookup", () => {
  it("uses Windows Path and PATHEXT in directory and extension order", () => {
    const options = windowsFiles([
      "C:\\first\\kimi.cmd",
      "C:\\first\\kimi.exe",
      "D:\\second\\kimi.exe",
    ]);
    expect(
      findExecutableCandidates(
        "kimi",
        { Path: "C:\\first;D:\\second", Pathext: ".EXE;.CMD" },
        options,
      ),
    ).toEqual(["C:\\first\\kimi.EXE", "C:\\first\\kimi.CMD", "D:\\second\\kimi.EXE"]);
  });

  it("supports quoted PATH entries and ignores case-only duplicate directories", () => {
    const options = windowsFiles(["C:\\Program Files\\Agents\\codex.cmd"]);
    expect(
      findExecutableCandidates(
        "codex",
        { Path: '"C:\\Program Files\\Agents";c:\\program files\\agents', PATHEXT: ".CMD" },
        options,
      ),
    ).toEqual(["C:\\Program Files\\Agents\\codex.CMD"]);
    expect(options.isExecutableFile).toHaveBeenCalledTimes(1);
  });

  it("resolves explicit Windows paths without appending an extension twice", () => {
    const options = windowsFiles(["D:\\agents\\claude.exe"]);
    expect(findExecutableCandidates("D:\\agents\\claude.exe", {}, options)).toEqual([
      "D:\\agents\\claude.exe",
    ]);
    expect(findExecutableCandidates("D:/agents/claude", { PATHEXT: ".EXE" }, options)).toEqual([
      "D:\\agents\\claude.EXE",
    ]);
  });

  it("does not search the current project implicitly for an unqualified CLI", () => {
    const options = windowsFiles(["C:\\workspace\\kimi.cmd"]);
    expect(findExecutableCandidates("kimi", {}, options)).toEqual([]);
  });

  it("uses default Windows executable extensions if PATHEXT is absent", () => {
    const options = windowsFiles(["C:\\bin\\tool.cmd"]);
    expect(findExecutableCandidates("tool", { Path: "C:\\bin" }, options)).toEqual([
      "C:\\bin\\tool.CMD",
    ]);
  });

  it("keeps POSIX lookup case-sensitive with no executable extension expansion", () => {
    const probe = vi.fn((file: string) => file === "/bin/kimi");
    expect(
      findExecutableCandidates(
        "kimi",
        { PATH: "/bin:/bin", Path: "/elsewhere", PATHEXT: ".EXE" },
        { platform: "darwin", isExecutableFile: probe },
      ),
    ).toEqual(["/bin/kimi"]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("normalizes duplicate Windows environment names using Node's lexical precedence", () => {
    const env = { Path: "second", PATH: "first", token: "lower", TOKEN: "upper" };
    expect(environmentValue(env, "Path", "win32")).toBe("first");
    expect(normalizeProcessEnvironment(env, "win32")).toEqual({ PATH: "first", TOKEN: "upper" });
    expect(normalizeProcessEnvironment(env, "darwin")).toBe(env);
  });

  it("uses the Windows command processor instead of inheriting a Git Bash SHELL", () => {
    expect(defaultShell({ ComSpec: "D:\\Windows\\cmd.exe", SHELL: "/bin/bash" }, "win32")).toBe(
      "D:\\Windows\\cmd.exe",
    );
    expect(defaultShell({ SystemRoot: "D:\\Windows" }, "win32")).toBe(
      "D:\\Windows\\System32\\cmd.exe",
    );
    expect(defaultShell({ SHELL: "/bin/zsh" }, "darwin")).toBe("/bin/zsh");
    expect(defaultShell({}, "linux")).toBe("/bin/sh");
  });
});
