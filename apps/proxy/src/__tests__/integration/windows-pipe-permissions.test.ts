import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { psString } from "#src/common/autostart-definition.js";
import { localIpcEndpointPath } from "#src/common/paths.js";
import { setLocalIpcEndpointPermissions } from "#src/common/local-ipc-endpoint.js";
import { WINDOWS_SERVICE_POWERSHELL_PREAMBLE } from "#src/common/windows-service.js";

// Native access checks with real Windows tokens, including the administrator's filtered token.
// The test never needs the password of the runner or an existing user.
const CLIENT = `using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class PipeAccessProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabledCount,
    SidAndAttributes[] disabled, uint deletedCount, IntPtr deleted, uint restrictedCount,
    IntPtr restricted, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool SetTokenInformation(IntPtr token, int kind, ref SidAndAttributes data, int length);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
  private static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  private static IntPtr Sid(string value) {
    var sid = new SecurityIdentifier(value);
    var data = new byte[sid.BinaryLength]; sid.GetBinaryForm(data, 0);
    var result = Marshal.AllocHGlobal(data.Length); Marshal.Copy(data, 0, result, data.Length);
    return result;
  }
  public static int Main(string[] args) {
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    IntPtr original = IntPtr.Zero, token = IntPtr.Zero, admin = IntPtr.Zero, label = IntPtr.Zero;
    try {
      if (args[0] == "other") {
        Check(LogonUser(args[2], ".", args[3], 2, 0, out token));
      } else {
        Check(OpenProcessToken(GetCurrentProcess(), 0x02000000, out original));
        admin = Sid("S-1-5-32-544");
        var disabled = new[] { new SidAndAttributes { Sid = admin } };
        Check(CreateRestrictedToken(original, 1, 1, disabled, 0, IntPtr.Zero, 0, IntPtr.Zero, out token));
        label = Sid(args[0] == "low" ? "S-1-16-4096" : "S-1-16-8192");
        var integrity = new SidAndAttributes { Sid = label, Attributes = 0x20 };
        Check(SetTokenInformation(token, 25, ref integrity, Marshal.SizeOf(typeof(SidAndAttributes)) + 12));
      }
      using (WindowsIdentity.Impersonate(token)) {
        var identity = WindowsIdentity.GetCurrent();
        if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
          throw new InvalidOperationException("Probe still has administrator access");
        try {
          using (var pipe = new NamedPipeClientStream(".", args[1].Substring(9), PipeDirection.InOut,
              PipeOptions.None, TokenImpersonationLevel.Identification)) {
            pipe.Connect(3000);
            var request = System.Text.Encoding.UTF8.GetBytes("probe\\n");
            pipe.Write(request, 0, request.Length); pipe.Flush();
            using (var reader = new StreamReader(pipe)) {
              if (reader.ReadLine() != "accepted") throw new InvalidOperationException("Invalid pipe reply");
            }
          }
          Console.WriteLine("ALLOWED " + identity.User.Value);
        } catch (UnauthorizedAccessException) { Console.WriteLine("DENIED"); }
      }
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    finally {
      if (token != IntPtr.Zero) CloseHandle(token);
      if (original != IntPtr.Zero) CloseHandle(original);
      if (admin != IntPtr.Zero) Marshal.FreeHGlobal(admin);
      if (label != IntPtr.Zero) Marshal.FreeHGlobal(label);
    }
  }
}
`;

describe.skipIf(
  process.platform !== "win32" || process.env.DEV_ANYWHERE_TEST_SYSTEM_SERVICE !== "1",
)("Windows named-pipe account access", () => {
  it("admits the same account without elevation and rejects other accounts and low-integrity clients", async () => {
    const root = mkdtempSync(join(tmpdir(), "da-pipe-access-"));
    const endpoint = localIpcEndpointPath(join(root, "control.sock"));
    const program = join(root, "probe.exe");
    const source = join(root, "probe.cs");
    const user = `dap${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const password = `${randomUUID()}Aa9!`;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => socket.end("accepted\n"));
    });
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
        { encoding: "utf8", timeout: 30_000, windowsHide: true },
      );
    const probe = async (mode: string) => {
      const result = await promisify(execFile)(program, [mode, endpoint, user, password], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      return result.stdout.trim();
    };
    try {
      writeFileSync(source, CLIENT);
      powershell(`Add-Type -Path ${psString(source)} -ReferencedAssemblies 'System.dll','System.Core.dll' -OutputAssembly ${psString(program)} -OutputType ConsoleApplication;
$account = New-LocalUser -Name ${psString(user)} -Password (ConvertTo-SecureString ${psString(password)} -AsPlainText -Force) -AccountNeverExpires;
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account;`);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
      });
      // Reproduce the shipped default-DACL failure before applying the actual repair.
      expect(await probe("medium")).toBe("DENIED");
      setLocalIpcEndpointPermissions(endpoint);
      for (let attempt = 0; attempt < 8; attempt++) {
        expect(await probe("medium")).toMatch(/^ALLOWED S-1-/);
      }
      expect(await probe("low")).toBe("DENIED");
      expect(await probe("other")).toBe("DENIED");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      powershell(
        `if (Get-LocalUser -Name ${psString(user)} -ErrorAction SilentlyContinue) { Remove-LocalUser -Name ${psString(user)}; }; exit 0;`,
      );
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
