import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// An administrator's service token makes Administrators the default pipe owner. Its
// unelevated desktop token cannot use that ACE. Grant the actual user SID explicitly.
const SOURCE = `using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class DevAnywherePipePermissions {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool SetKernelObjectSecurity(SafePipeHandle handle, uint information, byte[] descriptor);

  public static int Main(string[] args) {
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    try {
      if (args.Length != 2 || !(args[0].StartsWith(@"\\\\.\\pipe\\") || args[0].StartsWith(@"\\\\?\\pipe\\")))
        throw new ArgumentException("Expected a local named pipe and its server PID");
      uint expectedPid = uint.Parse(args[1]);
      var rights = PipeAccessRights.ReadWrite | PipeAccessRights.ReadPermissions |
        PipeAccessRights.ChangePermissions | PipeAccessRights.TakeOwnership;
      using (var pipe = new NamedPipeClientStream(".", args[0].Substring(9), rights,
          PipeOptions.None, TokenImpersonationLevel.Identification, HandleInheritability.None)) {
        pipe.Connect(3000);
        uint serverPid;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out serverPid))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        if (serverPid != expectedPid) throw new InvalidOperationException("Named pipe belongs to another process");
        using (var identity = WindowsIdentity.GetCurrent()) {
          // Retain local administrative access and explicitly admit this account's desktop token.
          // Keep other users, low-integrity processes and network logons out.
          var descriptor = new RawSecurityDescriptor("D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" +
            identity.User.Value + ")S:(ML;;NW;;;ME)");
          var data = new byte[descriptor.BinaryLength];
          descriptor.GetBinaryForm(data, 0);
          if (!SetKernelObjectSecurity(pipe.SafePipeHandle, 0x80000014, data))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
      }
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine("Cannot secure local pipe: " + error.Message);
      return 1;
    }
  }
}
`;

let helperPath: string | undefined;

function permissionHelper(): string {
  if (helperPath) return helperPath;
  const directory = join(homedir(), ".dev-anywhere", "helpers");
  const digest = createHash("sha256").update(SOURCE).digest("hex").slice(0, 20);
  const executable = join(directory, `pipe-permissions-${digest}.exe`);
  if (!existsSync(executable)) {
    mkdirSync(directory, { recursive: true });
    const candidate = `${executable}.${process.pid}.tmp.exe`;
    const script = `$ErrorActionPreference = 'Stop';
$env:PSModulePath = $PSHOME + '\\Modules';
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(SOURCE).toString("base64")}'));
$output = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(candidate).toString("base64")}'));
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.dll','System.Core.dll' -OutputAssembly $output -OutputType ConsoleApplication;`;
    try {
      execFileSync(
        join(
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
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { timeout: 30_000, windowsHide: true, stdio: "pipe" },
      );
      try {
        renameSync(candidate, executable);
      } catch (error) {
        // Another process can finish compiling the same source first.
        if (!existsSync(executable)) throw error;
      }
    } finally {
      rmSync(candidate, { force: true });
    }
  }
  helperPath = executable;
  return executable;
}

export function setWindowsPipePermissions(endpoint: string, serverPid = process.pid): void {
  execFileSync(permissionHelper(), [endpoint, String(serverPid)], {
    timeout: 5_000,
    windowsHide: true,
    stdio: "pipe",
  });
}
