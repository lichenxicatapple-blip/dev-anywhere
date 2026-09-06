import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { quoteWindowsArgument } from "./command-launch.js";
import { buildProxyProfilePaths } from "./paths.js";

function encodedString(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) {
    throw new Error("Autostart paths and environment must not contain control characters");
  }
  return `Decode("${Buffer.from(value, "utf8").toString("base64")}")`;
}

/** Compile only during registration; the task runs this GUI executable, never PowerShell. */
export function buildWindowsAutostartLauncher(options: {
  home: string;
  profile: string;
  executable: string;
  args: readonly string[];
}): { path: string; logPath: string; source: string; compileScript: string } {
  const paths = buildProxyProfilePaths(options.home, options.profile, "win32");
  const logPath = win32.join(paths.logDir, "autostart-launcher.log");
  const source = `using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class DevAnywhereAutostart {
  private static StreamWriter log;
  private static volatile bool logFailed;
  private static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
  private static void WriteLog(string stream, string message) {
    if (message == null) return;
    try { lock (log) { log.WriteLine(DateTime.UtcNow.ToString("o") + " " + stream + ": " + message); } }
    catch { logFailed = true; } // Keep draining output; report logging failures through the task exit code.
  }
  public static int Main() {
    try {
      string logPath = ${encodedString(logPath)};
      Directory.CreateDirectory(Path.GetDirectoryName(logPath));
      using (log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false))) {
        log.AutoFlush = true;
        try {
          var info = new ProcessStartInfo();
          info.FileName = ${encodedString(options.executable)};
          info.Arguments = ${encodedString(options.args.map(quoteWindowsArgument).join(" "))};
          info.WorkingDirectory = ${encodedString(options.home)};
          info.EnvironmentVariables["USERPROFILE"] = ${encodedString(options.home)};
          info.EnvironmentVariables["HOME"] = ${encodedString(options.home)};
          info.UseShellExecute = false;
          info.CreateNoWindow = true;
          info.RedirectStandardInput = true;
          info.RedirectStandardOutput = true;
          info.RedirectStandardError = true;
          info.StandardOutputEncoding = Encoding.UTF8;
          info.StandardErrorEncoding = Encoding.UTF8;
          using (var child = new Process()) {
            child.StartInfo = info;
            child.OutputDataReceived += (sender, e) => WriteLog("stdout", e.Data);
            child.ErrorDataReceived += (sender, e) => WriteLog("stderr", e.Data);
            child.Start();
            child.StandardInput.Close();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            child.WaitForExit();
            return child.ExitCode != 0 ? child.ExitCode : (logFailed ? 1 : 0);
          }
        } catch (Exception error) { WriteLog("launcher", error.ToString()); return 1; }
      }
    } catch { return 1; } // An unwritable log directory is also a failed task, not a silent success.
  }
}
`;
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 20);
  const path = win32.join(paths.profileDir, "autostart", `launcher-${digest}.exe`);
  // The source contains only encoded paths/argv, not credentials or a snapshot of the user's env.
  const sourceBase64 = Buffer.from(source, "utf8").toString("base64");
  const compileScript = `$launcherPath = '${path.replaceAll("'", "''")}';
if (!(Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($launcherPath)) | Out-Null;
  $candidate = $launcherPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp.exe';
  try {
    $source = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${sourceBase64}'));
    Add-Type -TypeDefinition $source -OutputAssembly $candidate -OutputType WindowsApplication -ErrorAction Stop;
    Move-Item -LiteralPath $candidate -Destination $launcherPath -ErrorAction Stop;
  } finally {
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force; }
  }
}`;
  return { path, logPath, source, compileScript };
}
