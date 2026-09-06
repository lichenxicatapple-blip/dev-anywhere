#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$TargetProcessId,

    [Parameter(Mandatory = $true)]
    [string]$TracePath,

    [string]$StopPath
)

$ErrorActionPreference = 'Stop'
$diagProcess = $null
$diagOutput = $null
$diagErrors = $null
$diagStarted = $false
$diagTimer = [System.Diagnostics.Stopwatch]::StartNew()
$diagResult = [ordered]@{
    status = 'error'
    cdbExitCode = $null
    elapsedMs = 0
    stackFrameCount = 0
    tracePath = $TracePath
    stderrPath = "$TracePath.stderr.log"
}
$diagExitCode = 1

try {
    if (-not $IsWindows) { throw 'Native stack capture requires Windows.' }
    if (-not [System.IO.Path]::IsPathFullyQualified($TracePath)) {
        throw 'TracePath must be an absolute path.'
    }
    if ($StopPath -and -not [System.IO.Path]::IsPathFullyQualified($StopPath)) {
        throw 'StopPath must be an absolute path.'
    }
    $diagDebugger = $env:DA_LIFECYCLE_DEBUGGER
    $diagSymbols = $env:DA_LIFECYCLE_SYMBOL_PATH
    if (-not $diagDebugger -or -not (Test-Path -LiteralPath $diagDebugger -PathType Leaf)) {
        throw 'DA_LIFECYCLE_DEBUGGER must identify the prepared CDB executable.'
    }
    if (-not $diagSymbols) { throw 'DA_LIFECYCLE_SYMBOL_PATH is required.' }

    # Never replace an earlier capture. The caller owns and validates the target PID.
    $diagOutput = [System.IO.FileStream]::new(
        $TracePath, [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read,
        1, [System.IO.FileOptions]::Asynchronous
    )
    $diagErrors = [System.IO.FileStream]::new(
        $diagResult.stderrPath, [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read,
        1, [System.IO.FileOptions]::Asynchronous
    )

    $diagStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $diagStartInfo.FileName = $diagDebugger
    $diagStartInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($TracePath)
    $diagStartInfo.UseShellExecute = $false
    $diagStartInfo.CreateNoWindow = $true
    $diagStartInfo.RedirectStandardInput = $true
    $diagStartInfo.RedirectStandardOutput = $true
    $diagStartInfo.RedirectStandardError = $true
    $diagCaptureId = [Guid]::NewGuid().ToString('N')
    $diagBegin = "DA_NATIVE_STACK_BEGIN_$diagCaptureId"
    $diagEnd = "DA_NATIVE_STACK_END_$diagCaptureId"
    $diagCommands = ".reload /f node.exe; .echo $diagBegin; ~* kc 40; .echo $diagEnd; qd"
    foreach ($diagArgument in @(
        '-pv', '-p', [string]$TargetProcessId,
        '-sins', '-y', $diagSymbols, '-noshell', '-nosqm',
        '-c', $diagCommands
    )) {
        $diagStartInfo.ArgumentList.Add($diagArgument)
    }
    $diagProcess = [System.Diagnostics.Process]::new()
    $diagProcess.StartInfo = $diagStartInfo
    if (-not $diagProcess.Start()) { throw 'CDB did not start.' }
    $diagStarted = $true
    $diagProcess.StandardInput.Close()

    # .NET copies both pipes concurrently; no PowerShell callbacks or memory dump.
    $diagOutputCopy = $diagProcess.StandardOutput.BaseStream.CopyToAsync($diagOutput)
    $diagErrorCopy = $diagProcess.StandardError.BaseStream.CopyToAsync($diagErrors)
    $diagCaptureTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $diagFinished = $false
    while (-not ($diagFinished = $diagProcess.WaitForExit(100))) {
        if ($StopPath -and [System.IO.File]::Exists($StopPath)) {
            $diagResult.status = 'cancelled'
            $diagExitCode = 125
            break
        }
        if ($diagCaptureTimer.ElapsedMilliseconds -ge 60000) {
            $diagResult.status = 'timeout'
            $diagExitCode = 124
            break
        }
    }
    if (-not $diagFinished) {
        # -pv does not establish a normal debugger attachment. Stop only this CDB.
        $diagProcess.Kill()
        if (-not $diagProcess.WaitForExit(2000)) {
            throw 'CDB did not finish after its own timeout termination.'
        }
    } else {
        $diagResult.cdbExitCode = $diagProcess.ExitCode
        if ($diagProcess.ExitCode -ne 0) {
            $diagResult.status = 'cdb-error'
        }
    }
    if (-not [System.Threading.Tasks.Task]::WaitAll(
        [System.Threading.Tasks.Task[]]@($diagOutputCopy, $diagErrorCopy), 2000
    )) {
        throw 'CDB output pipes did not finish draining.'
    }
    $diagOutput.Dispose()
    $diagOutput = $null
    if ($diagFinished -and $diagResult.cdbExitCode -eq 0) {
        $diagText = [System.IO.File]::ReadAllText($TracePath)
        # Whole-line markers exclude the startup command echoed by CDB itself.
        $diagBeginMatch = [regex]::Match($diagText, "(?m)^$diagBegin\r?$")
        $diagEndMatch = [regex]::Match($diagText, "(?m)^$diagEnd\r?$")
        if ($diagBeginMatch.Success -and $diagEndMatch.Success -and
            $diagEndMatch.Index -gt $diagBeginMatch.Index) {
            $diagStackStart = $diagBeginMatch.Index + $diagBeginMatch.Length
            $diagStack = $diagText.Substring($diagStackStart, $diagEndMatch.Index - $diagStackStart)
            $diagResult.stackFrameCount = [regex]::Matches(
                $diagStack, '(?m)^\s*(?:[0-9a-fA-F]+\s+)?[\w.-]+![^\r\n]+\r?$'
            ).Count
        }
        if ($diagResult.stackFrameCount -gt 0) {
            $diagResult.status = 'completed'
            $diagExitCode = 0
        } else {
            $diagResult.status = 'incomplete-capture'
            $diagResult.error = 'CDB returned without a complete marked native stack.'
        }
    }
} catch {
    $diagResult.error = $_.Exception.Message
    if ($diagExitCode -notin @(124, 125)) {
        $diagResult.status = 'error'
        $diagExitCode = 1
    }
} finally {
    if ($null -ne $diagProcess) {
        try {
            if ($diagStarted -and -not $diagProcess.HasExited) {
                $diagProcess.Kill()
                [void]$diagProcess.WaitForExit(2000)
            }
        } catch {
            $diagResult.cleanupError = $_.Exception.Message
        }
        $diagProcess.Dispose()
    }
    if ($null -ne $diagOutput) { $diagOutput.Dispose() }
    if ($null -ne $diagErrors) { $diagErrors.Dispose() }
    $diagResult.elapsedMs = $diagTimer.ElapsedMilliseconds
}

$diagResult | ConvertTo-Json -Compress
exit $diagExitCode
