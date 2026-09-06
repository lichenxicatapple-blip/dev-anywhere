param([int]$TargetProcessId, [string]$TracePath, [string]$TerminationPath, [string]$StopPath)
$ErrorActionPreference = 'Stop'
if ($TargetProcessId -le 0 -or !$TracePath -or !$TerminationPath -or !$StopPath) {
  throw 'Expected one fixture PID and fixture-owned journal/control paths'
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
function Write-Record($stage, $details = @{}) {
  $record = @{ stage = $stage; pid = $TargetProcessId; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  foreach ($key in $details.Keys) { $record[$key] = $details[$key] }
  [System.IO.File]::AppendAllText($TracePath, (($record | ConvertTo-Json -Compress -Depth 4) + "`n"), $utf8)
}
$targetHandle = [IntPtr]::Zero
$captureProcess = $null
try {
  # QUERY_LIMITED_INFORMATION | SYNCHRONIZE only; retain the same process identity.
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureProcessProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
  $targetHandle = [FixtureProcessProbe]::OpenProcess(0x101000, $false, $TargetProcessId)
  if ($targetHandle -eq [IntPtr]::Zero) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  [long]$created = 0; [long]$exited = 0; [long]$kernel = 0; [long]$user = 0
  if (![FixtureProcessProbe]::GetProcessTimes($targetHandle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  if ([FixtureProcessProbe]::WaitForSingleObject($targetHandle, 0) -ne 258) {
    throw 'Fixture worker was not running when its observation handle was acquired'
  }
  Write-Record 'armed' @{ creationFileTime = $created.ToString(); creationTimeUtc = [DateTime]::FromFileTimeUtc($created).ToString('o') }
  $budget = [Diagnostics.Stopwatch]::StartNew()
  $terminationAt = $null
  $captured = $false
  $signaled = $false
  while ($budget.ElapsedMilliseconds -lt 90000 -and !(Test-Path -LiteralPath $StopPath)) {
    if ($null -eq $terminationAt -and (Test-Path -LiteralPath $TerminationPath)) {
      $marker = [System.IO.File]::ReadAllText($TerminationPath).Trim()
      [long]$parsed = 0
      if ([long]::TryParse($marker, [ref]$parsed)) {
        $terminationAt = $parsed
        Write-Record 'termination-requested' @{ terminationAt = $terminationAt }
      }
    }
    if (!$signaled) {
      $waitResult = [FixtureProcessProbe]::WaitForSingleObject($targetHandle, 50)
      if ($waitResult -eq 0) {
        $signaled = $true
        [uint32]$exitCode = 0
        $exitOk = [FixtureProcessProbe]::GetExitCodeProcess($targetHandle, [ref]$exitCode)
        Write-Record 'signaled' @{ exitCode = $(if ($exitOk) { $exitCode } else { $null }); exitError = $(if ($exitOk) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }); terminationAt = $terminationAt }
      } elseif ($waitResult -ne 258) { throw "Unexpected process wait result: $waitResult" }
    } else { Start-Sleep -Milliseconds 50 }
    if ($null -ne $captureProcess -and $captureProcess.HasExited) {
      Write-Record 'diagnostic-complete' @{ hookExitCode = $captureProcess.ExitCode }
      $captureProcess.Dispose()
      $captureProcess = $null
    }
    if ($signaled -and $null -eq $captureProcess) { break }
    if (!$captured -and $null -ne $terminationAt -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $terminationAt -ge 10000) {
      $captured = $true
      # Keep this unsignaled handle open throughout the hook; never attach by a stale PID.
      if ([FixtureProcessProbe]::WaitForSingleObject($targetHandle, 0) -ne 258) { continue }
      [uint32]$diagnosticExitCode = 0
      $exitOk = [FixtureProcessProbe]::GetExitCodeProcess($targetHandle, [ref]$diagnosticExitCode)
      Write-Record 'diagnostic-ready' @{ terminationAt = $terminationAt; waitResult = 258; exitCode = $(if ($exitOk) { $diagnosticExitCode } else { $null }); exitError = $(if ($exitOk) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }) }
      if ($env:DA_LIFECYCLE_STACK_HOOK) {
        $arguments = @('-NoProfile', '-NonInteractive', '-File', ('"' + $env:DA_LIFECYCLE_STACK_HOOK + '"'), '-TargetProcessId', "$TargetProcessId", '-TracePath', ('"' + "$TracePath.stack.log" + '"'), '-StopPath', ('"' + $StopPath + '"'))
        $captureProcess = Start-Process -FilePath 'pwsh.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput "$TracePath.capture.json" -RedirectStandardError "$TracePath.capture-error.log"
      } else {
        Write-Record 'diagnostic-complete' @{ skipped = 'hook-not-configured' }
      }
    }
  }
} catch {
  Write-Record 'error' @{ errorType = $_.Exception.GetType().FullName; errorCode = $_.Exception.HResult; nativeError = $(if ($_.Exception -is [ComponentModel.Win32Exception]) { $_.Exception.NativeErrorCode } else { $null }) }
} finally {
  # Cancel only our capture child. Its hook stops its own debugger, never the fixture worker.
  if ($null -ne $captureProcess) {
    [System.IO.File]::WriteAllText($StopPath, 'stop', $utf8)
    if (!$captureProcess.WaitForExit(10000)) { $captureProcess.Kill(); [void]$captureProcess.WaitForExit(5000) }
    Write-Record 'diagnostic-complete' @{ hookExitCode = $(if ($captureProcess.HasExited) { $captureProcess.ExitCode } else { $null }); cancelled = $true }
    $captureProcess.Dispose()
  }
  if ($targetHandle -ne [IntPtr]::Zero) { [void][FixtureProcessProbe]::CloseHandle($targetHandle) }
  Write-Record 'observer-complete'
}
