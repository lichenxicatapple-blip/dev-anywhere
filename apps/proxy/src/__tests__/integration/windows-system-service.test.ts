import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { psString } from "#src/common/autostart-definition.js";
import {
  buildWindowsService,
  windowsServiceRegistration,
  WINDOWS_SERVICE_POWERSHELL_PREAMBLE,
} from "#src/common/windows-service.js";

function powershell(script: string): string {
  return execFileSync(
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
      Buffer.from(`${WINDOWS_SERVICE_POWERSHELL_PREAMBLE}\n${script}`, "utf16le").toString(
        "base64",
      ),
    ],
    { timeout: 45_000, windowsHide: true, encoding: "utf8" },
  ).trim();
}

describe.skipIf(process.platform !== "win32")("native Windows service wrapper", () => {
  it.each(["--console-test", "--console-shutdown-test"])(
    "forwards stop/shutdown and the user environment (%s)",
    async (mode) => {
      const home = await mkdtemp(join(tmpdir(), "da-service test-"));
      try {
        const wrapper = buildWindowsService({
          home,
          profile: "test",
          label: "dev-anywhere-test",
          executable: process.execPath,
          args: [
            "-e",
            "console.log(JSON.stringify({home:process.env.HOME,userprofile:process.env.USERPROFILE,args:process.argv.slice(1)}));process.stdin.on('data',()=>{console.log('stopped');process.exit(7)});",
            "--",
            'a "b"',
            "尾部\\",
          ],
          env: { HOME: home, USERPROFILE: home },
        });
        powershell(wrapper.compileScript);
        const child = spawn(wrapper.path, [mode], {
          windowsHide: true,
          stdio: ["pipe", "ignore", "ignore"],
        });
        const exit = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
        child.stdin.end("stop\n");
        expect(await exit).toBe(7);
        const log = await readFile(wrapper.logPath, "utf8");
        const result = JSON.parse(log.match(/stdout: (\{.*\})/)![1]!);
        expect(result).toEqual({ home, userprofile: home, args: ['a "b"', "尾部\\"] });
        expect(log).toContain("stdout: stopped");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe.skipIf(
  process.platform !== "win32" || process.env.DEV_ANYWHERE_TEST_SYSTEM_SERVICE !== "1",
)("native Windows SCM registration", () => {
  it("starts without an interactive logon under a temporary ordinary user and handles SCM stop", async () => {
    const name = `da${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const password = `${randomUUID()}Aa9!`;
    const label = `dev-anywhere-${name}`;
    const home = await mkdtemp(
      join(process.env.PUBLIC ?? "C:\\Users\\Public", "da-native-service-"),
    );
    const ready = join(home, "ready.json");
    const stopped = join(home, "stopped");
    const ptyModule = createRequire(import.meta.url).resolve("node-pty");
    const command = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const script = [
      `const pty=require(${JSON.stringify(ptyModule)});`,
      "console.log('Starting service PTY as '+require('node:os').userInfo().username);",
      `const shell=pty.spawn(${JSON.stringify(command)},['/d','/c','whoami'],{cwd:${JSON.stringify(home)},env:process.env,cols:80,rows:24,useConptyDll:true});`,
      "console.log('Service PTY started: '+shell.pid);",
      "let output='';shell.onData(data=>output+=data);const timer=setTimeout(()=>{console.error('Service PTY timed out: '+JSON.stringify(output));process.exit(3)},15000);",
      `shell.onExit(({exitCode})=>{clearTimeout(timer);require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({user:require('node:os').userInfo().username,pid:process.pid,home:process.env.HOME,shellExit:exitCode,shellOutput:output}));});`,
      `process.stdin.on('data',()=>{require('node:fs').writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});`,
    ].join("");
    const wrapper = buildWindowsService({
      home,
      profile: "test",
      label,
      executable: process.execPath,
      args: ["-e", script],
      env: { HOME: home, USERPROFILE: home },
    });
    let failed = false;
    try {
      powershell(wrapper.compileScript);
      // Credentials exist only in this disposable test. Never prompt for or use a real account.
      powershell(`$password = ConvertTo-SecureString ${psString(password)} -AsPlainText -Force;
New-LocalUser -Name ${psString(name)} -Password $password -AccountNeverExpires -PasswordNeverExpires | Out-Null;
$ownerName = $env:COMPUTERNAME + '\\' + ${psString(name)};
$ownerSid = (New-Object Security.Principal.NTAccount($ownerName)).Translate([Security.Principal.SecurityIdentifier]).Value;
$acl = Get-Acl -LiteralPath ${psString(home)};
$identity = New-Object Security.Principal.SecurityIdentifier($ownerSid);
$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow');
$acl.AddAccessRule($rule);
Set-Acl -LiteralPath ${psString(home)} -AclObject $acl;
function Get-Credential { param($UserName, $Message); return New-Object Management.Automation.PSCredential($ownerName, $password); }
$service = $null;
${windowsServiceRegistration(label, wrapper.path)}
Start-Service -Name ${psString(label)};`);
      const deadline = Date.now() + 20_000;
      while (!existsSync(ready) && Date.now() < deadline) await sleep(100);
      const result = JSON.parse(await readFile(ready, "utf8"));
      expect(result).toMatchObject({ user: name, home, shellExit: 0 });
      expect(result.shellOutput.toLowerCase()).toContain(`\\${name}`);
      const servicePid = Number(
        powershell(
          `(Get-CimInstance Win32_Service -Filter ${psString(`Name='${label}'`)}).ProcessId;`,
        ),
      );
      expect(servicePid).toBeGreaterThan(0);
      powershell(
        `Stop-Service -Name ${psString(label)};
(Get-Service -Name ${psString(label)}).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20));
Wait-Process -Id ${servicePid},${result.pid} -Timeout 10 -ErrorAction SilentlyContinue;
if (Get-Process -Id ${servicePid},${result.pid} -ErrorAction SilentlyContinue) { throw 'Service processes did not exit'; }`,
      );
      expect(await readFile(stopped, "utf8")).toBe("stopped");
    } catch (error) {
      failed = true;
      console.error(
        "SCM service log before failure:",
        await readFile(wrapper.logPath, "utf8").catch(() => "No service log was created"),
      );
      throw error;
    } finally {
      try {
        powershell(`$service = Get-Service -Name ${psString(label)} -ErrorAction SilentlyContinue;
if ($service) {
  $serviceProcessId = (Get-CimInstance Win32_Service -Filter ${psString(`Name='${label}'`)}).ProcessId;
  Stop-Service -InputObject $service -ErrorAction SilentlyContinue;
  $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20));
  if ($serviceProcessId) { Wait-Process -Id $serviceProcessId -Timeout 5 -ErrorAction SilentlyContinue; }
  & sc.exe delete ${psString(label)} | Out-Null;
}
$account = Get-LocalUser -Name ${psString(name)} -ErrorAction SilentlyContinue;
if ($account) {
  try {
    Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $account.SID.Value } | Remove-CimInstance;
  } catch {
    # Windows can retain the profile hive after both service processes have exited.
    # The disposable runner reclaims it; service/account removal must still complete.
    Write-Warning 'Windows retained the disposable account profile until runner shutdown';
  } finally {
    Remove-LocalUser -Name ${psString(name)};
  }
}
exit 0;`);
      } catch (error) {
        if (!failed) throw error;
        console.error("SCM fixture cleanup also failed:", error);
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }, 90_000);
});
