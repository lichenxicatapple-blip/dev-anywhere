import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWindowsAutostartLauncher } from "#src/common/windows-autostart-launcher.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function powershell(script: string): void {
  execFileSync(
    win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(`$ErrorActionPreference = 'Stop';\n${script}`, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 30_000, encoding: "utf8" },
  );
}

describe.skipIf(process.platform !== "win32")("native Windows GUI autostart launcher", () => {
  it("runs Node without a console entrypoint and preserves argv, login env, logs and exit code", async () => {
    const home = await mkdtemp(join(tmpdir(), "da-launcher test-"));
    roots.push(home);
    const args = ["C:\\开发项目\\trailing slash\\", 'quoted "value"', "", "& $not_a_command"];
    const script =
      "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),home:process.env.HOME,userprofile:process.env.USERPROFILE,marker:process.env.DA_LAUNCHER_TEST}));console.error('中文启动错误');setTimeout(()=>process.exit(7),100);";
    const launcher = buildWindowsAutostartLauncher({
      home,
      profile: "test",
      executable: process.execPath,
      args: ["-e", script, "--", ...args],
    });
    powershell(launcher.compileScript);
    const binary = await readFile(launcher.path);
    // PE optional-header Subsystem=2 is Windows GUI, not console (3).
    expect(binary.readUInt16LE(binary.readUInt32LE(0x3c) + 24 + 68)).toBe(2);
    const result = spawnSync(launcher.path, [], {
      env: { ...process.env, DA_LAUNCHER_TEST: "inherited", HOME: "old", USERPROFILE: "old" },
      windowsHide: true,
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    const log = await readFile(launcher.logPath, "utf8");
    const output = JSON.parse(log.match(/stdout: (\{.*\})/)![1]!);
    expect(output).toEqual({ args, cwd: home, home, userprofile: home, marker: "inherited" });
    expect(log).toContain("stderr: 中文启动错误");
  }, 40_000);

  it("gives a console child no console handle and logs launch failures instead of reporting success", async () => {
    const home = await mkdtemp(join(tmpdir(), "da-no-console test-"));
    roots.push(home);
    const probePath = join(home, "console-probe.exe");
    const probeSource =
      'using System; using System.Runtime.InteropServices; public static class Probe { [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow(); public static int Main() { Console.WriteLine("console=" + GetConsoleWindow().ToInt64()); return 7; } }';
    powershell(
      `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(probeSource).toString("base64")}')); Add-Type -TypeDefinition $source -OutputAssembly '${probePath.replaceAll("'", "''")}' -OutputType ConsoleApplication;`,
    );
    const launcher = buildWindowsAutostartLauncher({
      home,
      profile: "test",
      executable: probePath,
      args: [],
    });
    powershell(launcher.compileScript);
    expect(spawnSync(launcher.path, [], { windowsHide: true, timeout: 10_000 }).status).toBe(7);
    expect(await readFile(launcher.logPath, "utf8")).toContain("stdout: console=0");

    const missing = buildWindowsAutostartLauncher({
      home,
      profile: "missing",
      executable: join(home, "absent.exe"),
      args: [],
    });
    powershell(missing.compileScript);
    expect(spawnSync(missing.path, [], { windowsHide: true, timeout: 10_000 }).status).toBe(1);
    expect(await readFile(missing.logPath, "utf8")).toContain(
      "launcher: System.ComponentModel.Win32Exception",
    );
  }, 60_000);
});
