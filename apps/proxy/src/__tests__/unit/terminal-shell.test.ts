import { describe, expect, it, vi } from "vitest";
import {
  getTerminalShellFamily,
  listTerminalShells,
  resolveTerminalShell,
} from "#src/common/terminal-shell.js";

it.each([
  ["/bin/zsh", "zsh"],
  ["/usr/bin/bash", "bash"],
  ["/opt/homebrew/bin/fish", "fish"],
  ["C:\\Program Files\\PowerShell\\7\\PWSH.EXE", "powershell"],
  ["powershell.exe", "powershell"],
  ["C:\\Windows\\System32\\cmd.exe", "cmd"],
  ["/bin/sh", undefined],
  ["/usr/local/bin/bash-wrapper", undefined],
])("identifies the executable %s without guessing unknown shells", (command, family) => {
  expect(getTerminalShellFamily(command!)).toBe(family);
});

const pwsh = "D:\\Tools\\PowerShell\\pwsh.exe";
const installedPwsh = "D:\\Program Files\\PowerShell\\7\\pwsh.exe";
const powershell = "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const cmd = "D:\\Windows\\System32\\cmd.exe";
const env = {
  Path: "D:\\Tools\\PowerShell;D:\\Other",
  SystemRoot: "D:\\Windows",
  ProgramFiles: "D:\\Program Files",
  ComSpec: "D:\\Unrelated\\powershell.exe",
};

function windowsOptions(files: string[]) {
  return {
    platform: "win32" as const,
    cwd: "D:\\project",
    isExecutableFile: vi.fn((file: string) => files.includes(file)),
  };
}

describe("Windows interactive terminal shells", () => {
  it("prefers PowerShell 7 on PATH and advertises only shell IDs and labels", () => {
    const options = windowsOptions([pwsh, installedPwsh, powershell, cmd]);
    expect(listTerminalShells(env, options)).toEqual([
      { id: "powershell", label: "PowerShell 7" },
      { id: "cmd", label: "CMD" },
    ]);
    expect(resolveTerminalShell(undefined, env, options)).toEqual({
      command: pwsh,
      label: "PowerShell 7",
    });
    expect(resolveTerminalShell("powershell", env, options).command).toBe(pwsh);
  });

  it("finds PowerShell 7 in Program Files when it is absent from PATH", () => {
    expect(
      resolveTerminalShell("powershell", env, windowsOptions([installedPwsh, powershell, cmd])),
    ).toEqual({ command: installedPwsh, label: "PowerShell 7" });
  });

  it("falls back to Windows PowerShell with case-insensitive environment keys", () => {
    const options = windowsOptions([powershell, cmd]);
    expect(resolveTerminalShell(undefined, { systemroot: "D:\\Windows" }, options)).toEqual({
      command: powershell,
      label: "Windows PowerShell",
    });
    expect(listTerminalShells(env, options)).toEqual([
      { id: "powershell", label: "Windows PowerShell" },
      { id: "cmd", label: "CMD" },
    ]);
  });

  it("launches the system CMD when explicitly chosen, independently of ComSpec and PATH", () => {
    const options = windowsOptions([pwsh, powershell, cmd]);
    expect(resolveTerminalShell("cmd", env, options)).toEqual({ command: cmd, label: "CMD" });
  });

  it("defaults to CMD only when PowerShell is unavailable", () => {
    const options = windowsOptions([cmd]);
    expect(resolveTerminalShell(undefined, env, options)).toEqual({ command: cmd, label: "CMD" });
    expect(listTerminalShells(env, options)).toEqual([{ id: "cmd", label: "CMD" }]);
    expect(() => resolveTerminalShell("powershell", env, options)).toThrow("PowerShell 不可用");
  });

  it("rejects an unavailable CMD instead of launching another shell", () => {
    expect(() => resolveTerminalShell("cmd", env, windowsOptions([pwsh]))).toThrow("CMD 不可用");
    expect(listTerminalShells(env, windowsOptions([]))).toEqual([]);
    expect(() => resolveTerminalShell(undefined, env, windowsOptions([]))).toThrow("Shell 不可用");
  });

  it("uses the standard Windows system directory when SystemRoot is absent", () => {
    const options = windowsOptions(["C:\\Windows\\System32\\cmd.exe"]);
    expect(resolveTerminalShell(undefined, {}, options).command).toBe(
      "C:\\Windows\\System32\\cmd.exe",
    );
  });

  it.each(["linux", "darwin"] as const)("preserves the configured shell on %s", (platform) => {
    const options = { platform, isExecutableFile: vi.fn() };
    expect(listTerminalShells({ SHELL: "/bin/zsh" }, options)).toBeUndefined();
    expect(resolveTerminalShell(undefined, { SHELL: "/bin/zsh" }, options)).toEqual({
      command: "/bin/zsh",
    });
    expect(resolveTerminalShell(undefined, {}, options)).toEqual({ command: "/bin/sh" });
    expect(() => resolveTerminalShell("powershell", {}, options)).toThrow("仅支持 Windows");
    expect(() => resolveTerminalShell("cmd", {}, options)).toThrow("仅支持 Windows");
    expect(options.isExecutableFile).not.toHaveBeenCalled();
  });
});
