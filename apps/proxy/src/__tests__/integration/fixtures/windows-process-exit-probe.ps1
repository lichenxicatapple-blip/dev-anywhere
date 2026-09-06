param([int]$TargetProcessId)
$ErrorActionPreference = 'Stop'
if ($TargetProcessId -le 0) { throw 'Expected one positive fixture PID' }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Read-only handles only: no termination access, signals, or process reports.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureProcessProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
$nativeCheckedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
# PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
$handle = [FixtureProcessProbe]::OpenProcess(0x101000, $false, $TargetProcessId)
$openError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
$native = @{ checkedAt = $nativeCheckedAt; openError = 0 }
if ($handle -eq [IntPtr]::Zero) {
  $native.openError = $openError
} else {
  try {
    [uint32]$exitCode = 0
    $exitOk = [FixtureProcessProbe]::GetExitCodeProcess($handle, [ref]$exitCode)
    $native.exitError = if ($exitOk) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    $native.exitCode = if ($exitOk) { $exitCode } else { $null }
    $native.waitResult = [FixtureProcessProbe]::WaitForSingleObject($handle, 0)
    $native.waitError = if ($native.waitResult -eq [uint32]::MaxValue) { [Runtime.InteropServices.Marshal]::GetLastWin32Error() } else { 0 }
  } finally {
    [void][FixtureProcessProbe]::CloseHandle($handle)
  }
}
try {
  $target = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId" -Property ProcessId,ParentProcessId,CommandLine
  $result = @{ status = $(if ($target) { 'found' } else { 'absent' }); native = $native }
  if ($target) {
    $result.parentPid = $target.ParentProcessId
    $result.commandLine = $target.CommandLine
  }
} catch {
  $result = @{ status = 'error'; errorCode = $_.Exception.GetType().Name; native = $native }
}
$result | ConvertTo-Json -Depth 3 -Compress
