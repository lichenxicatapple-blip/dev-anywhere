import { describe, expect, it } from "vitest";
import { win32 } from "node:path";
import { quoteWindowsArgument } from "#src/common/command-launch.js";
import { buildWindowsAutostartLauncher } from "#src/common/windows-autostart-launcher.js";

const options = {
  home: "C:\\Users\\Developer",
  profile: "default",
  executable: "C:\\Program Files\\nodejs\\node.exe",
  args: ["C:\\DEV Anywhere\\index.js", "--profile", "default", "serve", "autostart", "run"],
};

function decodedAssignment(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped} = Decode\\("([A-Za-z0-9+/=]+)"\\)`));
  expect(match, name).not.toBeNull();
  return Buffer.from(match![1]!, "base64").toString("utf8");
}

describe("Windows GUI autostart launcher", () => {
  it("uses immutable source-addressed executables in the selected user profile", () => {
    const launcher = buildWindowsAutostartLauncher(options);
    expect(launcher.path).toMatch(
      /^C:\\Users\\Developer\\\.dev-anywhere\\autostart\\launcher-[a-f0-9]{20}\.exe$/,
    );
    expect(buildWindowsAutostartLauncher(options)).toEqual(launcher);
    expect(
      buildWindowsAutostartLauncher({ ...options, args: [...options.args, "new"] }).path,
    ).not.toBe(launcher.path);
    const named = buildWindowsAutostartLauncher({ ...options, profile: "work" });
    expect(win32.dirname(named.path)).toBe(
      "C:\\Users\\Developer\\.dev-anywhere\\profiles\\work\\autostart",
    );
    expect(named.logPath).toBe(
      "C:\\Users\\Developer\\.dev-anywhere\\profiles\\work\\logs\\autostart-launcher.log",
    );
  });

  it("round-trips Unicode, quotes, trailing slashes and shell metacharacters without a shell", () => {
    const args = ["C:\\开发项目\\a b\\", 'quoted "value"', "", "'; $env:SECRET; & echo nope"];
    const launcher = buildWindowsAutostartLauncher({
      ...options,
      home: "C:\\Users\\O'Neil 开发",
      args,
    });
    expect(decodedAssignment(launcher.source, "info.Arguments")).toBe(
      args.map(quoteWindowsArgument).join(" "),
    );
    expect(decodedAssignment(launcher.source, "info.FileName")).toBe(options.executable);
    expect(decodedAssignment(launcher.source, "info.WorkingDirectory")).toBe(
      "C:\\Users\\O'Neil 开发",
    );
    expect(launcher.source).not.toContain("$env:SECRET");
    expect(launcher.source).toContain("info.UseShellExecute = false;");
    expect(launcher.compileScript).toContain("O''Neil 开发");
  });

  it("inherits login environment except the same explicit HOME and USERPROFILE as before", () => {
    const { source } = buildWindowsAutostartLauncher(options);
    expect(decodedAssignment(source, 'info.EnvironmentVariables["HOME"]')).toBe(options.home);
    expect(decodedAssignment(source, 'info.EnvironmentVariables["USERPROFILE"]')).toBe(
      options.home,
    );
    expect(source.match(/info\.EnvironmentVariables\[/g)).toHaveLength(2);
    expect(source).not.toMatch(/EnvironmentVariables\.Clear|Password|UserName|PATH/);
  });

  it("compiles a GUI application before publishing and never rewrites an existing hash", () => {
    const { compileScript, source } = buildWindowsAutostartLauncher(options);
    const encodedSource = compileScript.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)![1]!;
    expect(Buffer.from(encodedSource, "base64").toString("utf8")).toBe(source);
    expect(compileScript).toContain("-OutputType WindowsApplication -ErrorAction Stop");
    expect(compileScript).toContain("if (!(Test-Path -LiteralPath $launcherPath -PathType Leaf))");
    expect(compileScript).toContain("Move-Item -LiteralPath $candidate -Destination $launcherPath");
    expect(compileScript).toContain("Remove-Item -LiteralPath $candidate -Force");
    expect(compileScript).not.toContain("-Recurse");
    expect(source).toContain("info.CreateNoWindow = true;");
    expect(source).not.toMatch(/WindowStyle|powershell|cmd\.exe|Restart|Kill\(/);
  });

  it("drains both child streams to a profile log and preserves exit codes and launch failures", () => {
    const { source, logPath } = buildWindowsAutostartLauncher(options);
    expect(decodedAssignment(source, "logPath")).toBe(logPath);
    expect(source).toContain("child.BeginOutputReadLine();");
    expect(source).toContain("child.BeginErrorReadLine();");
    expect(source).toContain("info.StandardOutputEncoding = Encoding.UTF8;");
    expect(source).toContain("info.StandardErrorEncoding = Encoding.UTF8;");
    expect(source).toContain("child.WaitForExit();");
    expect(source).toContain("return child.ExitCode != 0 ? child.ExitCode : (logFailed ? 1 : 0);");
    expect(source).toContain('WriteLog("launcher", error.ToString()); return 1;');
  });

  it("rejects paths outside valid profile names and control characters", () => {
    expect(() => buildWindowsAutostartLauncher({ ...options, profile: "../outside" })).toThrow(
      "Invalid dev-anywhere profile",
    );
    expect(() => buildWindowsAutostartLauncher({ ...options, executable: "node\n.exe" })).toThrow(
      "control characters",
    );
    expect(() => buildWindowsAutostartLauncher({ ...options, args: ["hello\rworld"] })).toThrow(
      "control characters",
    );
  });
});
