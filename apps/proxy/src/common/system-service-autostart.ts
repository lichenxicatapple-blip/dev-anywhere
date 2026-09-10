import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  autostartLabel,
  checkAutostartText,
  psString,
  readIfPresent,
  removeIfPresent,
  unitValue,
  unitString,
  xmlString,
  type AutostartOptions,
} from "./autostart-definition.js";
import { buildProxyProfilePaths } from "./paths.js";
import {
  buildWindowsService,
  windowsServiceRegistration,
  WINDOWS_SERVICE_POWERSHELL_PREAMBLE,
} from "./windows-service.js";

const execFileAsync = promisify(execFile);
async function runCommand(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}
async function runInteractive(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve("")
        : reject(
            new Error(`System service registration command exited with code ${code ?? "unknown"}`),
          ),
    );
  });
}

export function createSystemServiceAutostart(
  options: AutostartOptions & {
    /** Interactive elevation/password prompts happen only during registration and activation. */
    runInteractive?: typeof runInteractive;
    /** An isolated directory for definition tests; production uses the OS-owned directory. */
    systemDirectory?: string;
  },
) {
  const { platform, home, profile, executable, env } = options;
  if (!["darwin", "linux", "win32"].includes(platform))
    throw new Error(`System services are not supported on ${platform}`);
  const label = `${autostartLabel(home, profile)}-system`;
  const unit = `${label}.service`;
  const paths = buildProxyProfilePaths(home, profile, platform);
  const filePath = join(
    options.systemDirectory ??
      (platform === "darwin" ? "/Library/LaunchDaemons" : "/etc/systemd/system"),
    platform === "darwin" ? `${label}.plist` : unit,
  );
  const run = options.run ?? runCommand;
  const interactive = options.runInteractive ?? runInteractive;
  const args = [...options.args, "--profile", profile, "serve", "autostart", "run", "--system"];
  const environment: Record<string, string> = {
    HOME: checkAutostartText(home),
    ...(platform === "win32" ? { USERPROFILE: checkAutostartText(home) } : {}),
    ...Object.fromEntries(
      [
        "PATH",
        "SHELL",
        "XDG_CONFIG_HOME",
        ...(platform === "win32" ? ["APPDATA", "LOCALAPPDATA"] : []),
      ].flatMap((key) => (env[key] ? [[key, checkAutostartText(env[key]!)]] : [])),
    ),
  };
  const powershell = win32.join(
    env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const lookup = `$service = Get-CimInstance -ClassName Win32_Service -Filter ${psString(`Name='${label}'`)} -ErrorAction Stop;`;
  const powerShell = (script: string) =>
    run(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(`${WINDOWS_SERVICE_POWERSHELL_PREAMBLE}\n${script}`, "utf16le").toString(
        "base64",
      ),
    ]);
  const privileged = (command: string, commandArgs: string[]) =>
    interactive("/usr/bin/sudo", [command, ...commandArgs]);
  const requireUser = () => {
    if (!options.uid || !options.username)
      throw new Error(
        "Run system-service registration as your normal user; it requests sudo only for installation",
      );
    checkAutostartText(options.username);
  };
  async function stage<T>(
    content: string,
    fn: (path: string) => Promise<T>,
    suffix = "definition",
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "dev-anywhere-service-"));
    const path = join(directory, suffix);
    try {
      await writeFile(path, content, { mode: 0o600 });
      return await fn(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async function windowsMutation(script: string) {
    // Capture the profile owner's identity BEFORE UAC, which may use a different administrator.
    const owner = z
      .object({ name: z.string().min(1), sid: z.string().regex(/^S-1-/) })
      .parse(
        JSON.parse(
          await powerShell(
            "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); @{ name = $identity.Name; sid = $identity.User.Value } | ConvertTo-Json -Compress;",
          ),
        ),
      );
    const source = `param([switch]$Elevated)
${WINDOWS_SERVICE_POWERSHELL_PREAMBLE}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if ($Elevated) { throw 'Administrator privileges are required to install a system service'; }
  $child = Start-Process -FilePath ${psString(powershell)} -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Elevated') -Verb RunAs -Wait -PassThru;
  exit $child.ExitCode;
}
try {
  $ownerName = ${psString(owner.name)};
  $ownerSid = ${psString(owner.sid)};
  ${lookup}
  if ($service) {
    $account = New-Object Security.Principal.NTAccount($service.StartName);
    if ($account.Translate([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid) { throw 'Existing service belongs to another account'; }
  }
  ${script}
} catch {
  Write-Error $_ -ErrorAction Continue;
  if ($Elevated) { Read-Host 'Service operation failed. Press Enter to close this window' | Out-Null; }
  exit 1;
}
`;
    // A file avoids Windows' command-line length limit; it contains no password or tokens.
    await stage(
      `\ufeff${source}`,
      (path) =>
        interactive(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path]),
      "register.ps1",
    );
  }
  function definition(): string {
    requireUser();
    const user = options.username!;
    const userEnv = { ...environment, USER: user, LOGNAME: user };
    if (platform === "darwin")
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlString(label)}</string>
<key>UserName</key><string>${xmlString(user)}</string>
<key>ProgramArguments</key><array>${[executable, ...args].map((arg) => `<string>${xmlString(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xmlString(home)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(userEnv)
        .map(([key, value]) => `<key>${xmlString(key)}</key><string>${xmlString(value)}</string>`)
        .join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>120</integer>
</dict></plist>
`;
    return `[Unit]
Description=DEV Anywhere system service (${checkAutostartText(profile)})
Wants=network-online.target
After=network-online.target
RequiresMountsFor=${unitString(home)}

[Service]
Type=simple
User=${unitValue(user)}
WorkingDirectory=${unitValue(home)}
${Object.entries(userEnv)
  .map(([key, value]) => `Environment=${unitString(`${key}=${value}`)}`)
  .join("\n")}
ExecStart=:${[executable, ...args].map(unitString).join(" ")}
Restart=no
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
`;
  }
  const install = (source: string) =>
    privileged("/usr/bin/install", [
      "-o",
      "root",
      "-g",
      platform === "darwin" ? "wheel" : "root",
      "-m",
      "644",
      source,
      filePath,
    ]);
  async function status(): Promise<boolean> {
    if (platform === "win32") {
      return z
        .boolean()
        .parse(
          JSON.parse(
            (
              await powerShell(
                `${lookup}\n[bool]($service -and $service.StartMode -eq 'Auto') | ConvertTo-Json -Compress;`,
              )
            ).trim(),
          ),
        );
    }
    if ((await readIfPresent(filePath)) === null) return false;
    if (platform === "darwin")
      return !(await run("/bin/launchctl", ["print-disabled", "system"])).includes(
        `"${label}" => true`,
      );
    return (
      (
        await run("systemctl", ["--system", "show", unit, "--property=UnitFileState", "--value"])
      ).trim() === "enabled"
    );
  }
  async function enable(): Promise<void> {
    if (platform === "win32") {
      const wrapper = buildWindowsService({
        home,
        profile,
        label,
        executable,
        args,
        env: environment,
      });
      await windowsMutation(
        `${wrapper.compileScript}\n${windowsServiceRegistration(label, wrapper.path)}`,
      );
    } else {
      const content = definition();
      const previous = await readIfPresent(filePath);
      await stage(content, install);
      try {
        if (platform === "darwin")
          await privileged("/bin/launchctl", ["enable", `system/${label}`]);
        else {
          await privileged("systemctl", ["--system", "daemon-reload"]);
          await privileged("systemctl", ["--system", "enable", unit]);
        }
      } catch (error) {
        if (previous === null) await privileged("/bin/rm", ["-f", filePath]);
        else await stage(previous, install);
        if (platform === "linux") await privileged("systemctl", ["--system", "daemon-reload"]);
        throw error;
      }
    }
    await mkdir(dirname(paths.systemAutostartPath), { recursive: true });
    await writeFile(paths.systemAutostartPath, `${label}\n`, { mode: 0o600 });
  }
  async function disable(): Promise<void> {
    if (platform === "win32") {
      if (await status())
        await windowsMutation(`if ($service) {
  $result = Invoke-CimMethod -InputObject $service -MethodName ChangeStartMode -Arguments @{ StartMode = 'Disabled' };
  if ($result.ReturnValue -ne 0) { throw ('Service disable failed: ' + $result.ReturnValue); }
}`);
    } else if ((await readIfPresent(filePath)) !== null) {
      requireUser();
      if (platform === "darwin") await privileged("/bin/launchctl", ["disable", `system/${label}`]);
      else await privileged("systemctl", ["--system", "disable", unit]);
      await privileged("/bin/rm", ["-f", filePath]);
      if (platform === "linux") await privileged("systemctl", ["--system", "daemon-reload"]);
    }
    await removeIfPresent(paths.systemAutostartPath);
  }
  async function activate(): Promise<void> {
    if (platform === "win32") {
      await windowsMutation(
        `if (!$service) { throw 'System service is not installed'; }\nStart-Service -Name ${psString(label)};`,
      );
    } else if (platform === "darwin") {
      requireUser();
      let loaded = false;
      try {
        await run("/bin/launchctl", ["print", `system/${label}`]);
        loaded = true;
      } catch (error) {
        // launchctl uses ESRCH (3/113) for an unloaded service. Other failures must remain visible.
        if (![3, 113].includes(Number((error as { code?: unknown }).code))) throw error;
      }
      if (!loaded) await privileged("/bin/launchctl", ["bootstrap", "system", filePath]);
      else await privileged("/bin/launchctl", ["kickstart", `system/${label}`]);
    } else {
      requireUser();
      await privileged("systemctl", ["--system", "start", unit]);
    }
  }
  return { label, filePath, enable, disable, status, activate };
}
