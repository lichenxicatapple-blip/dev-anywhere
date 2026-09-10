import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { createSystemServiceAutostart } from "../src/common/system-service-autostart.js";
import { psString } from "../src/common/autostart-definition.js";
import { WINDOWS_SERVICE_POWERSHELL_PREAMBLE } from "../src/common/windows-service.js";

// Only disposable native CI hosts run this helper. The ordinary Windows service account is
// created here, never logged into the desktop, and removed along with its service afterwards.
export async function installAcceptanceService(options: {
  home: string;
  profile: string;
  entry: string;
  environmentModule: string;
  root: string;
}) {
  const powershell = (script: string) =>
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(`${WINDOWS_SERVICE_POWERSHELL_PREAMBLE}\n${script}`, "utf16le").toString(
          "base64",
        ),
      ],
      { encoding: "utf8", timeout: 60000, windowsHide: true },
    ).trim();
  const sudo = (command: string, args: string[]) =>
    execFileSync("/usr/bin/sudo", ["-n", command, ...args], { encoding: "utf8", timeout: 30000 });
  const name = `dau${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = `${randomUUID()}Aa9!`;
  let owner: { name: string; sid: string };
  if (process.platform === "win32") {
    owner = JSON.parse(
      powershell(`
$password = ConvertTo-SecureString ${psString(password)} -AsPlainText -Force;
$account = New-LocalUser -Name ${psString(name)} -Password $password -AccountNeverExpires -PasswordNeverExpires;
$acl = Get-Acl -LiteralPath ${psString(options.root)};
$rule = New-Object Security.AccessControl.FileSystemAccessRule($account.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow');
$acl.AddAccessRule($rule); Set-Acl -LiteralPath ${psString(options.root)} -AclObject $acl;
@{ name = [Environment]::MachineName + '\\' + $account.Name; sid = $account.SID.Value } | ConvertTo-Json -Compress;
`),
    );
  }
  const manager = createSystemServiceAutostart({
    platform: process.platform,
    home: options.home,
    profile: options.profile,
    executable: process.execPath,
    args: ["--import", options.environmentModule, options.entry],
    env: process.env,
    uid: process.getuid?.(),
    username: userInfo().username,
    run: async (command, args) => {
      if (process.platform === "win32") {
        const source = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
        if (source.includes("$identity =")) return JSON.stringify(owner);
      }
      return execFileSync(command, args, { encoding: "utf8", timeout: 60000, windowsHide: true });
    },
    runInteractive: async (command, args) => {
      if (process.platform !== "win32") return sudo(args[0]!, args.slice(1));
      return powershell(`
function Get-Credential {
  param($UserName, $Message);
  New-Object Management.Automation.PSCredential(${psString(owner.name)}, (ConvertTo-SecureString ${psString(password)} -AsPlainText -Force));
}
& ${psString(args.at(-1)!)};`);
    },
  });
  const dispose = async () => {
    if (process.platform === "win32") {
      powershell(`
$service = Get-Service -Name ${psString(manager.label)} -ErrorAction SilentlyContinue;
if ($service) {
  Stop-Service -InputObject $service -ErrorAction SilentlyContinue;
  $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90));
  & sc.exe delete ${psString(manager.label)} | Out-Null;
}
Remove-LocalUser -Name ${psString(name)} -ErrorAction SilentlyContinue;
`);
    } else {
      try {
        if (process.platform === "linux")
          sudo("systemctl", ["--system", "stop", `${manager.label}.service`]);
        else sudo("/bin/launchctl", ["bootout", `system/${manager.label}`]);
      } finally {
        await manager.disable();
        if (process.platform === "darwin")
          sudo("/bin/launchctl", ["enable", `system/${manager.label}`]);
      }
    }
  };
  try {
    await manager.enable();
    await manager.activate();
    return { label: manager.label, dispose };
  } catch (error) {
    await dispose().catch((cleanupError) => console.error("Service cleanup:", cleanupError));
    throw error;
  }
}
