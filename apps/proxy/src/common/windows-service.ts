import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { buildProxyProfilePaths } from "./paths.js";
import { quoteWindowsArgument } from "./command-launch.js";
import { checkAutostartText, psString } from "./autostart-definition.js";

// A CLI launched from pwsh can inherit PowerShell 7 modules, incompatible with powershell.exe.
export const WINDOWS_SERVICE_POWERSHELL_PREAMBLE = `$ErrorActionPreference = 'Stop';
$env:PSModulePath = $PSHOME + '\\Modules';
$ProgressPreference = 'SilentlyContinue';
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
function Get-DevAnywhereAccountSid([string]$Name) {
  # SCM abbreviates the local machine as a dot; NTAccount needs the actual machine name.
  if ($Name.StartsWith('.\\')) { $Name = [Environment]::MachineName + $Name.Substring(1); }
  $account = New-Object Security.Principal.NTAccount($Name);
  return $account.Translate([Security.Principal.SecurityIdentifier]).Value;
}`;

function encoded(value: string): string {
  return `Decode("${Buffer.from(checkAutostartText(value), "utf8").toString("base64")}")`;
}

/** An SCM service, running as the user's account. Node itself does not implement ServiceMain. */
export function buildWindowsService(options: {
  home: string;
  profile: string;
  label: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
}) {
  const paths = buildProxyProfilePaths(options.home, options.profile, "win32");
  const logPath = win32.join(paths.logDir, "system-service.log");
  const source = `using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;

public sealed class DevAnywhereService : ServiceBase {
  private Process child;
  private StreamWriter log;
  private volatile bool stopping;
  private static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
  public DevAnywhereService() {
    ServiceName = ${encoded(options.label)};
    CanStop = true; CanShutdown = true; AutoLog = false;
  }
  private void WriteLog(string stream, string message) {
    if (message == null || log == null) return;
    try { lock (log) { log.WriteLine(DateTime.UtcNow.ToString("o") + " " + stream + ": " + message); } }
    catch { } // Draining the child's pipes must continue even if its log disk fills.
  }
  private void StartChild() {
    string logPath = ${encoded(logPath)};
    Directory.CreateDirectory(Path.GetDirectoryName(logPath));
    log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false));
    log.AutoFlush = true;
    var info = new ProcessStartInfo();
    info.FileName = ${encoded(options.executable)};
    info.Arguments = ${encoded(options.args.map(quoteWindowsArgument).join(" "))};
    info.WorkingDirectory = ${encoded(options.home)};
    ${Object.entries(options.env)
      .map(([key, value]) => `info.EnvironmentVariables[${encoded(key)}] = ${encoded(value)};`)
      .join("\n    ")}
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.RedirectStandardInput = true;
    info.RedirectStandardOutput = true;
    info.RedirectStandardError = true;
    info.StandardOutputEncoding = Encoding.UTF8;
    info.StandardErrorEncoding = Encoding.UTF8;
    child = new Process();
    child.StartInfo = info;
    child.OutputDataReceived += (sender, e) => WriteLog("stdout", e.Data);
    child.ErrorDataReceived += (sender, e) => WriteLog("stderr", e.Data);
    child.Start();
    child.BeginOutputReadLine();
    child.BeginErrorReadLine();
  }
  protected override void OnStart(string[] args) {
    StartChild();
    ThreadPool.QueueUserWorkItem(_ => {
      child.WaitForExit();
      if (!stopping) { ExitCode = child.ExitCode; Stop(); }
    });
  }
  private void StopChild(bool requestedStop) {
    stopping = true;
    if (child == null) return;
    if (!child.HasExited) {
      if (requestedStop) RequestAdditionalTime(120000);
      try { child.StandardInput.WriteLine("stop"); child.StandardInput.Flush(); }
      catch (IOException) { }
      if (!child.WaitForExit(110000)) { child.Kill(); ExitCode = 1; }
    }
  }
  protected override void OnStop() { StopChild(true); }
  protected override void OnShutdown() { StopChild(false); }
  public static int Main(string[] args) {
    using (var service = new DevAnywhereService()) {
      // Native tests exercise the compiled process/pipe contract without installing an OS service.
      if (args.Length == 1 && (args[0] == "--console-test" || args[0] == "--console-shutdown-test")) {
        try {
          service.StartChild();
          ThreadPool.QueueUserWorkItem(_ => {
            Console.ReadLine();
            if (args[0] == "--console-shutdown-test") { service.OnShutdown(); return; }
            try { service.child.StandardInput.WriteLine("stop"); service.child.StandardInput.Flush(); }
            catch (IOException) { }
          });
          service.child.WaitForExit();
          return service.child.ExitCode;
        } catch (Exception error) { service.WriteLog("host", error.ToString()); return 1; }
      }
      ServiceBase.Run(service);
      return 0;
    }
  }
}
`;
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 20);
  const path = win32.join(paths.profileDir, "autostart", `service-${digest}.exe`);
  const compileScript = `$servicePath = ${psString(path)};
if (!(Test-Path -LiteralPath $servicePath -PathType Leaf)) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($servicePath)) | Out-Null;
  $candidate = $servicePath + '.' + [guid]::NewGuid().ToString('N') + '.tmp.exe';
  try {
    $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString("base64")}'));
    Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.dll','System.ServiceProcess.dll' -OutputAssembly $candidate -OutputType WindowsApplication -ErrorAction Stop;
    Move-Item -LiteralPath $candidate -Destination $servicePath -ErrorAction Stop;
  } finally { if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force; } }
}`;
  return { path, source, logPath, compileScript };
}

export function windowsServiceRegistration(label: string, binaryPath: string): string {
  return `$binaryPath = ${psString(quoteWindowsArgument(binaryPath))};
if ($service) {
  if ((Get-DevAnywhereAccountSid $service.StartName) -ne $ownerSid) { throw 'Existing service belongs to another account'; }
  $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{ PathName = $binaryPath; StartMode = 'Automatic' };
  if ($result.ReturnValue -ne 0) { throw ('Service update failed: ' + $result.ReturnValue); }
} else {
  Add-Type -AssemblyName System.ServiceProcess;
  Add-Type -AssemblyName System.Configuration.Install;
  Add-Type -ReferencedAssemblies 'System.dll','System.Configuration.Install.dll' -TypeDefinition @'
using System;
using System.Collections;
using System.ComponentModel;
using System.Configuration.Install;
using System.Runtime.InteropServices;
public sealed class DevAnywhereCredentialValidator : Installer {
  public string Username { get; set; }
  public string Password { get; set; }
  public int LogonError { get; private set; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  public override void Install(IDictionary stateSaver) {
    base.Install(stateSaver);
    int separator = Username.IndexOf((char)92);
    string domain = separator < 0 ? null : Username.Substring(0, separator);
    string user = separator < 0 ? Username : Username.Substring(separator + 1);
    IntPtr token;
    // Validate the same service logon that SCM will use, after the parent grants its logon right.
    if (!LogonUser(user, domain, Password, 5, 0, out token)) {
      LogonError = Marshal.GetLastWin32Error();
      throw new Win32Exception(LogonError);
    }
    CloseHandle(token);
  }
}
'@;
  while ($true) {
    $credential = Get-Credential -UserName $ownerName -Message 'DEV Anywhere: enter this account password (Microsoft account password if applicable, not the Windows Hello PIN). Windows will verify it before installation.';
    if (!$credential) { throw 'Service installation cancelled'; }
    if ((Get-DevAnywhereAccountSid $credential.UserName) -ne $ownerSid) { throw 'Use the same account that owns this DEV Anywhere profile'; }
    $processInstaller = New-Object System.ServiceProcess.ServiceProcessInstaller;
    $processInstaller.Account = [System.ServiceProcess.ServiceAccount]::User;
    $processInstaller.Username = $ownerName;
    $processInstaller.Password = $credential.GetNetworkCredential().Password;
    $validator = New-Object DevAnywhereCredentialValidator;
    $validator.Username = $ownerName;
    $validator.Password = $processInstaller.Password;
    $installer = New-Object System.ServiceProcess.ServiceInstaller;
    $installer.ServiceName = ${psString(label)};
    $installer.DisplayName = ${psString(`DEV Anywhere (${label})`)};
    $installer.Description = 'DEV Anywhere Proxy: run before desktop login as the profile owner';
    $installer.StartType = [System.ServiceProcess.ServiceStartMode]::Automatic;
    $processInstaller.Installers.Add($validator) | Out-Null;
    $processInstaller.Installers.Add($installer) | Out-Null;
    $processInstaller.Context = New-Object System.Configuration.Install.InstallContext($null, @('/LogToConsole=false'));
    $processInstaller.Context.Parameters['assemblypath'] = $binaryPath;
    $state = @{};
    try {
      # ServiceProcessInstaller grants SeServiceLogonRight and rolls it back on failed installation.
      $processInstaller.Install($state);
      $processInstaller.Commit($state);
      Write-Host 'Windows 服务账户验证通过。';
      break;
    } catch {
      $processInstaller.Rollback($state);
      if ($validator.LogonError -eq 1326) {
        Write-Warning 'Windows 未接受这个账户密码，请重新输入。微软账户需填写微软账户密码，不能使用 PIN；取消凭据窗口可退出。';
        continue;
      }
      throw;
    } finally {
      $processInstaller.Password = $null;
      $validator.Password = $null;
      $credential = $null;
    }
  }
}`;
}
