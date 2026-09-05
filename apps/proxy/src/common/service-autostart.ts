import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import { quoteWindowsArgument } from "./command-launch.js";

interface AutostartOptions {
  platform: NodeJS.Platform;
  home: string;
  profile: string;
  executable: string;
  /** Absolute CLI entry and any runtime arguments (e.g. the source-mode TS loader). */
  args: string[];
  env: NodeJS.ProcessEnv;
  uid?: number;
  run?: (command: string, args: string[]) => Promise<string>;
}

function checkText(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) {
    throw new Error("Autostart paths and environment must not contain control characters");
  }
  return value;
}

function xml(value: string): string {
  return checkText(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
}

function unitString(value: string): string {
  return `"${checkText(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function psString(value: string): string {
  return `'${checkText(value).replaceAll("'", "''")}'`;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const execFileAsync = promisify(execFile);

/** Registers a login trigger, not another process supervisor. Enabling never restarts a Proxy. */
export function createServiceAutostart(options: AutostartOptions) {
  const { platform, home, profile, executable, env } = options;
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`Proxy autostart is not supported on ${platform}`);
  }
  const identity = createHash("sha256").update(`${home}\0${profile}`).digest("hex").slice(0, 20);
  const label = `dev-anywhere-${identity}`;
  const args = [...options.args, "--profile", profile, "serve", "autostart", "run"];
  const run =
    options.run ??
    (async (command: string, commandArgs: string[]) => {
      const result = await execFileAsync(command, commandArgs, {
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        encoding: "utf8",
      });
      return result.stdout;
    });
  const powershell = win32.join(
    env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const runPowerShell = (script: string) =>
    run(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShell(`$ErrorActionPreference = 'Stop';\n${script}`),
    ]);
  const taskLookup = `$task = Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq ${psString(label)} };`;
  const unit = `${label}.service`;
  const filePath =
    platform === "darwin"
      ? join(home, "Library", "LaunchAgents", `${label}.plist`)
      : join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", unit);
  const domain = `gui/${options.uid}`;
  const launchdTarget = `${domain}/${label}`;

  const environment = {
    HOME: checkText(home),
    ...Object.fromEntries(
      ["PATH", "SHELL"].flatMap((key) => (env[key] ? [[key, checkText(env[key]!)]] : [])),
    ),
  };

  function definition(): string {
    if (platform === "darwin") {
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${[executable, ...args].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
        .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
        .join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
</dict></plist>
`;
    }
    // Keep the unit active after the short-lived start command exits. Otherwise systemd would
    // terminate the detached Proxy (and its updater) along with that command's control group.
    return `[Unit]
Description=DEV Anywhere Proxy (${checkText(profile)})

[Service]
Type=oneshot
RemainAfterExit=yes
Restart=no
WorkingDirectory=${unitString(home)}
${Object.entries(environment)
  .map(([key, value]) => `Environment=${unitString(`${key}=${value}`)}`)
  .join("\n")}
ExecStart=:${[executable, ...args, "--daemon"].map(unitString).join(" ")}
TimeoutStartSec=60

[Install]
WantedBy=default.target
`;
  }

  function windowsTask(): string {
    const launcher = `$ErrorActionPreference = 'Stop';
$info = New-Object System.Diagnostics.ProcessStartInfo;
$info.FileName = ${psString(executable)};
$info.Arguments = ${psString(args.map(quoteWindowsArgument).join(" "))};
$info.WorkingDirectory = ${psString(home)};
$info.EnvironmentVariables['USERPROFILE'] = ${psString(home)};
$info.EnvironmentVariables['HOME'] = ${psString(home)};
$info.UseShellExecute = $false;
$info.CreateNoWindow = $true;
$child = [System.Diagnostics.Process]::Start($info);
$child.WaitForExit();
exit $child.ExitCode;`;
    return `$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name;
$action = New-ScheduledTaskAction -Execute ${psString(powershell)} -Argument ${psString(`-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodePowerShell(launcher)}`)};
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user;
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 4;
Register-ScheduledTask -TaskPath '\\' -TaskName ${psString(label)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'DEV Anywhere Proxy: start at user login' -Force | Out-Null;`;
  }

  async function status(): Promise<boolean> {
    if (platform === "win32") {
      const output = await runPowerShell(
        `${taskLookup}\n[bool]($task -and $task.Settings.Enabled) | ConvertTo-Json -Compress;`,
      );
      const enabled: unknown = JSON.parse(output.trim());
      if (typeof enabled !== "boolean") throw new Error("Invalid Windows autostart status");
      return enabled;
    }
    if ((await readIfPresent(filePath)) === null) return false;
    if (platform === "darwin") {
      if (options.uid === undefined) throw new Error("Cannot determine the current macOS user");
      const output = await run("/bin/launchctl", ["print-disabled", domain]);
      return !output.includes(`"${label}" => true`);
    }
    const output = await run("systemctl", [
      "--user",
      "show",
      unit,
      "--property=UnitFileState",
      "--value",
    ]);
    return output.trim() === "enabled";
  }

  async function enable(): Promise<void> {
    if (platform === "win32") {
      await runPowerShell(windowsTask());
      return;
    }
    if (platform === "darwin" && options.uid === undefined) {
      throw new Error("Cannot determine the current macOS user");
    }
    const content = definition();
    await mkdir(dirname(filePath), { recursive: true });
    const previous = await readIfPresent(filePath);
    await writeFile(filePath, content, { mode: 0o600 });
    try {
      if (platform === "darwin") {
        // No bootstrap/kickstart: registration takes effect at the next login, without touching
        // a running Proxy. An existing system-disabled override must not defeat re-enabling.
        await run("/bin/launchctl", ["enable", launchdTarget]);
      } else {
        await run("systemctl", ["--user", "daemon-reload"]);
        await run("systemctl", ["--user", "enable", unit]);
      }
    } catch (error) {
      if (previous === null) await removeIfPresent(filePath);
      else await writeFile(filePath, previous, { mode: 0o600 });
      throw error;
    }
  }

  async function disable(): Promise<void> {
    if (platform === "win32") {
      await runPowerShell(
        `${taskLookup}\nif ($task) { $task | Unregister-ScheduledTask -Confirm:$false; }`,
      );
      return;
    }
    if ((await readIfPresent(filePath)) === null) return;
    if (platform === "darwin") {
      if (options.uid === undefined) throw new Error("Cannot determine the current macOS user");
      await run("/bin/launchctl", ["disable", launchdTarget]);
    } else {
      await run("systemctl", ["--user", "disable", unit]);
    }
    await removeIfPresent(filePath);
    if (platform === "linux") await run("systemctl", ["--user", "daemon-reload"]);
    // Never bootout, stop, or unregister with process termination: disabling only affects login.
  }

  return { enable, disable, status };
}
