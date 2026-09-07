# Run with Windows PowerShell 5.1 or PowerShell 7. This suite never contacts a
# server: HTTP is mocked, and a local executable captures SSH argv and stdin.
[CmdletBinding()]
param([string]$InstallerPath)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# Resolve the script directory after parameter binding in Windows PowerShell.
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $InstallerPath = Join-Path $PSScriptRoot '../../install.ps1'
}
$InstallerPath = (Resolve-Path $InstallerPath).Path
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$testDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('dev-anywhere-powershell-test-' + [guid]::NewGuid().ToString('N'))
$null = [System.IO.Directory]::CreateDirectory($testDirectory)
$savedEnvironment = @{}
foreach ($name in @('REGISTRY_BASE', 'IMAGE_TAG', 'DEV_ANYWHERE_RELAY_PORT', 'DEV_ANYWHERE_TEST_CAPTURE', 'DEV_ANYWHERE_TEST_SSH_EXIT')) {
    $savedEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name)
}
$originalTls = [System.Net.ServicePointManager]::SecurityProtocol
$originalInputEncoding = [Console]::InputEncoding
$originalInputReader = [Console]::In

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Assert-Fails {
    param([scriptblock]$Action, [string]$Expected)
    $failure = $null
    try { & $Action } catch { $failure = $_ }
    Assert-True ($null -ne $failure) "Expected failure containing '$Expected'."
    Assert-True ($failure.Exception.Message.Contains($Expected)) "Unexpected failure: $($failure.Exception.Message)"
}

try {
    $parseTokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$parseTokens, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) "Installer must parse on PowerShell $($PSVersionTable.PSVersion)."

    # Extract private functions without running the entry point or changing its
    # public API. The same functions used by the live entry point run below.
    $definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
    foreach ($definition in $definitions) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }

    $script:httpRequests = New-Object System.Collections.ArrayList
    $script:scenario = 'success'
    $script:revision = '0123456789abcdef0123456789abcdef01234567'
    function Invoke-WebRequest {
        [CmdletBinding()]
        param([switch]$UseBasicParsing, [string]$Uri, [hashtable]$Headers, [string]$UserAgent, [string]$OutFile, [int]$TimeoutSec)
        $null = $script:httpRequests.Add([pscustomobject]@{ Uri = $Uri; Headers = $Headers; OutFile = $OutFile })
        if ($script:scenario -eq 'forbid-http') { throw 'Unexpected HTTP request.' }
        if ($Uri.EndsWith('/commits/main')) {
            if ($script:scenario -eq 'invalid-sha') { $text = '{"sha":"not-a-raw-sha"}' }
            else { $text = $script:revision + "`n" }
        }
        elseif ($Uri.EndsWith('/scripts/lib/install-relay-render.sh')) {
            if ($script:scenario -eq 'helper-failure') { throw 'Simulated helper download failure.' }
            $text = "#!/usr/bin/env bash`nrender_dev_anywhere_compose() { :; }`n"
        }
        elseif ($Uri.EndsWith('/scripts/deploy/install-relay.sh')) {
            if ($script:scenario -eq 'installer-failure') {
                [System.IO.File]::WriteAllText($OutFile, 'echo partial-download', $utf8)
                throw 'Simulated interrupted installer download.'
            }
            if ($script:scenario -eq 'empty-installer') { $text = '' }
            else { $text = "#!/usr/bin/env bash`n# deployment fixture; no services touched`nprintf '%s\n' complete`n" }
        }
        else { throw "Unexpected URL: $Uri" }
        [System.IO.File]::WriteAllText($OutFile, $text, $utf8)
    }

    $script:scenario = 'forbid-http'
    $null = & $InstallerPath -Help
    Assert-True ($script:httpRequests.Count -eq 0) 'Help must not make HTTP requests.'

    $capturePath = Join-Path $testDirectory 'capture'
    [System.Environment]::SetEnvironmentVariable('DEV_ANYWHERE_TEST_CAPTURE', $capturePath)
    [System.Environment]::SetEnvironmentVariable('DEV_ANYWHERE_TEST_SSH_EXIT', '0')
    $runningOnWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
    if ($runningOnWindows) {
        $script:sshFixture = Join-Path $testDirectory 'ssh-fixture.exe'
        $source = @'
using System;
using System.IO;
using System.Text;
public static class SshFixture {
    public static int Main(string[] args) {
        var capture = Environment.GetEnvironmentVariable("DEV_ANYWHERE_TEST_CAPTURE");
        File.WriteAllLines(capture + ".args", args, new UTF8Encoding(false));
        using (var output = File.Create(capture + ".stdin")) {
            Console.OpenStandardInput().CopyTo(output);
        }
        return Int32.Parse(Environment.GetEnvironmentVariable("DEV_ANYWHERE_TEST_SSH_EXIT") ?? "0");
    }
}
'@
        # Compile using the Windows-included .NET Framework PowerShell even when
        # this suite runs under PS 7. The resulting exe exercises actual Windows
        # command-line parsing and does not require an installed compiler SDK.
        $compiler = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $sourcePath = Join-Path $testDirectory 'ssh-fixture.cs'
        [System.IO.File]::WriteAllText($sourcePath, $source, $utf8)
        $compileScript = 'Add-Type -Path ' + "'" + $sourcePath.Replace("'", "''") + "'" +
            ' -OutputAssembly ' + "'" + $script:sshFixture.Replace("'", "''") + "'" + ' -OutputType ConsoleApplication -ErrorAction Stop'
        $encodedCompile = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($compileScript))
        & $compiler -NoProfile -NonInteractive -EncodedCommand $encodedCompile
        Assert-True ($LASTEXITCODE -eq 0 -and [System.IO.File]::Exists($script:sshFixture)) 'Windows SSH fixture compilation failed.'
    }
    else {
        $script:sshFixture = Join-Path $testDirectory 'ssh-fixture'
        $source = @'
#!/bin/sh
printf '%s\n' "$@" > "$DEV_ANYWHERE_TEST_CAPTURE.args"
cat > "$DEV_ANYWHERE_TEST_CAPTURE.stdin"
exit "${DEV_ANYWHERE_TEST_SSH_EXIT:-0}"
'@
        [System.IO.File]::WriteAllText($script:sshFixture, $source + "`n", $utf8)
        & chmod +x $script:sshFixture
        Assert-True ($LASTEXITCODE -eq 0) 'Could not make the local SSH fixture executable.'
    }

    $script:sshAvailable = $true
    function Get-Command {
        [CmdletBinding()]
        param([string]$Name, $CommandType)
        if ($Name -ne 'ssh') { throw "Unexpected command lookup: $Name" }
        if ($script:sshAvailable) { [pscustomobject]@{ Source = $script:sshFixture } }
    }
    function Read-Host {
        param([string]$Prompt)
        if ($Prompt.StartsWith('SSH')) { return 'root@fixture.example' }
        return 'relay.example.com'
    }

    $specialSetting = 'registry.example/space '' quote " $dollar $(printf INJECTED) `backtick; ' + [char]0x4e2d + [char]0x6587
    [System.Environment]::SetEnvironmentVariable('REGISTRY_BASE', $specialSetting)
    [System.Environment]::SetEnvironmentVariable('IMAGE_TAG', 'v1.2.3')
    [System.Environment]::SetEnvironmentVariable('DEV_ANYWHERE_RELAY_PORT', '43100')
    # A UTF-8 console can prepend a BOM when .NET Framework opens child stdin.
    # Reproduce this regardless of the machine's default console code page.
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($true)
    $inputReaderBeforeSsh = [Console]::In
    $script:scenario = 'success'
    Install-DevAnywhereRelay -SshTarget 'root@fixture.example' -PublicHost 'relay.example.com'
    Assert-True ([Console]::InputEncoding.CodePage -eq 65001 -and [Console]::InputEncoding.GetPreamble().Length -eq 3) 'SSH startup must restore the original console input encoding.'
    Assert-True ([object]::ReferenceEquals([Console]::In, $inputReaderBeforeSsh)) 'SSH startup must preserve the existing console input reader.'

    Assert-True ($script:httpRequests.Count -eq 3) 'Expected one SHA request and two component downloads.'
    Assert-True ($script:httpRequests[0].Headers.Accept -eq 'application/vnd.github.sha') 'SHA lookup must request the raw SHA representation.'
    foreach ($request in @($script:httpRequests[1], $script:httpRequests[2])) {
        Assert-True ($request.Uri.Contains("/$($script:revision)/")) 'Both components must use the same resolved SHA.'
        Assert-True (-not [System.IO.File]::Exists($request.OutFile)) 'Downloaded temporary files must be cleaned up.'
    }
    Assert-True ([System.Net.ServicePointManager]::SecurityProtocol -eq $originalTls) 'TLS settings must be restored after downloading.'
    $nativeArgs = [System.IO.File]::ReadAllLines($capturePath + '.args', $utf8)
    Assert-True ($nativeArgs.Count -eq 4) 'SSH must receive exactly four argv items.'
    Assert-True ($nativeArgs[0] -eq '-T' -and $nativeArgs[1] -eq '--') 'SSH must disable PTY and terminate option parsing.'
    Assert-True ($nativeArgs[2] -eq 'root@fixture.example') 'SSH destination must remain one native argv item.'
    Assert-True ($nativeArgs[3] -ceq (Get-RelayRemoteCommand)) 'Native argv parsing must preserve the entire fixed remote command.'
    Assert-True (-not ($nativeArgs -join ' ').Contains($specialSetting)) 'Configuration must not appear in the process command line.'

    $wireBytes = [System.IO.File]::ReadAllBytes($capturePath + '.stdin')
    $headerEnd = [Array]::IndexOf($wireBytes, [byte]10)
    Assert-True ($headerEnd -gt 0) 'Transport must include a byte-count header.'
    $headerText = [System.Text.Encoding]::ASCII.GetString($wireBytes, 0, $headerEnd)
    Assert-True ($headerText -cmatch '\A[0-9]+\z') 'Transport header must contain only ASCII digits, without a BOM.'
    $expectedSize = [int]$headerText
    Assert-True ($expectedSize -eq ($wireBytes.Length - $headerEnd - 1)) 'Declared payload length must match actual UTF-8 bytes.'
    $payloadText = $utf8.GetString($wireBytes, $headerEnd + 1, $expectedSize)
    Assert-True ($payloadText.StartsWith("set -euo pipefail`n")) 'Payload must start without a UTF-8 BOM.'
    Assert-True (-not $payloadText.Contains("`r")) 'Payload must use Unix newlines.'
    $quoteEscape = "'" + '\' + "''"
    $expectedSetting = "export REGISTRY_BASE='" + $specialSetting.Replace("'", $quoteEscape) + "'"
    Assert-True ($payloadText.Contains($expectedSetting)) 'Special characters and Unicode must reach stdin without evaluation or encoding loss.'
    Assert-True ($payloadText.Contains("export IMAGE_TAG='v1.2.3'")) 'IMAGE_TAG must be forwarded.'
    Assert-True ($payloadText.Contains("export DEV_ANYWHERE_RELAY_PORT='43100'")) 'Relay port must be forwarded.'
    Assert-True ($payloadText.Contains("set -- 'relay.example.com'")) 'Public host must be passed as a quoted positional argument.'
    Assert-True ($payloadText.IndexOf('render_dev_anywhere_compose') -lt $payloadText.IndexOf('# deployment fixture')) 'Render helpers must precede the installer.'

    foreach ($failure in @(
        @{ Scenario = 'invalid-sha'; Message = 'valid commit SHA' },
        @{ Scenario = 'helper-failure'; Message = 'helper download failure' },
        @{ Scenario = 'installer-failure'; Message = 'interrupted installer download' },
        @{ Scenario = 'empty-installer'; Message = 'component is empty' }
    )) {
        [System.IO.File]::Delete($capturePath + '.args')
        [System.IO.File]::Delete($capturePath + '.stdin')
        $script:httpRequests.Clear()
        $script:scenario = $failure.Scenario
        Assert-Fails { Install-DevAnywhereRelay -SshTarget 'root@fixture.example' -PublicHost 'relay.example.com' } $failure.Message
        Assert-True (-not [System.IO.File]::Exists($capturePath + '.args')) 'Failed downloads must never launch SSH.'
        foreach ($request in $script:httpRequests) {
            Assert-True (-not [System.IO.Directory]::Exists([System.IO.Path]::GetDirectoryName($request.OutFile))) 'Failure must clean the download directory.'
        }
        Assert-True ([System.Net.ServicePointManager]::SecurityProtocol -eq $originalTls) 'Failure must restore TLS settings.'
    }

    $script:scenario = 'forbid-http'
    Assert-Fails { Install-DevAnywhereRelay -SshTarget '-oProxyCommand=invalid' -PublicHost 'relay.example.com' } 'SSH destination'
    $script:sshAvailable = $false
    Assert-Fails { Install-DevAnywhereRelay -SshTarget 'root@fixture.example' -PublicHost 'relay.example.com' } 'OpenSSH client was not found'
    $script:sshAvailable = $true
    $script:scenario = 'success'
    [System.Environment]::SetEnvironmentVariable('DEV_ANYWHERE_TEST_SSH_EXIT', '37')
    Assert-Fails { Install-DevAnywhereRelay -SshTarget 'root@fixture.example' -PublicHost 'relay.example.com' } 'exit code 37'
    Assert-True ([Console]::InputEncoding.CodePage -eq 65001 -and [Console]::InputEncoding.GetPreamble().Length -eq 3) 'Failed SSH must restore the original console input encoding.'
    Assert-Fails { Invoke-RelaySsh -SshPath (Join-Path $testDirectory 'missing-ssh.exe') -Target 'root@fixture.example' -Payload ([byte[]]@(49, 10)) } ''
    Assert-True ([Console]::InputEncoding.CodePage -eq 65001 -and [Console]::InputEncoding.GetPreamble().Length -eq 3) 'Failed process startup must restore the original console input encoding.'
    Assert-True ([object]::ReferenceEquals([Console]::In, $inputReaderBeforeSsh)) 'Failed process startup must preserve the existing console input reader.'
    [System.Environment]::SetEnvironmentVariable('DEV_ANYWHERE_TEST_SSH_EXIT', '0')
    Install-DevAnywhereRelay
    $promptedArgs = [System.IO.File]::ReadAllLines($capturePath + '.args', $utf8)
    Assert-True ($promptedArgs[2] -eq 'root@fixture.example') 'Missing parameters must use the interactive prompts.'

    # Exercise the documented public entry points as well as the isolated core.
    # In particular, iex must retain access to the mocks while the entry point
    # keeps its own preference changes and helper functions in a child scope.
    $installerSource = [System.IO.File]::ReadAllText($InstallerPath, $utf8)
    $script:httpRequests.Clear()
    Invoke-Expression $installerSource
    $interactiveArgs = [System.IO.File]::ReadAllLines($capturePath + '.args', $utf8)
    Assert-True ($interactiveArgs[2] -eq 'root@fixture.example') 'The public iex entry point must support interactive destination input.'
    Assert-True ($script:httpRequests.Count -eq 3) 'The public iex entry point must complete all three mocked downloads.'
    $script:httpRequests.Clear()
    & ([scriptblock]::Create($installerSource)) -SshTarget 'deploy@explicit.example' -PublicHost 'explicit.example.com'
    $explicitArgs = [System.IO.File]::ReadAllLines($capturePath + '.args', $utf8)
    Assert-True ($explicitArgs[2] -eq 'deploy@explicit.example') 'The public scriptblock entry point must forward explicit parameters.'
    $explicitWire = [System.IO.File]::ReadAllText($capturePath + '.stdin', $utf8)
    Assert-True ($explicitWire.Contains("set -- 'explicit.example.com'")) 'The public scriptblock entry point must forward PublicHost.'
    Assert-True ($script:httpRequests.Count -eq 3) 'The public scriptblock entry point must complete all three mocked downloads.'

    Write-Host "PowerShell installer tests passed ($($PSVersionTable.PSVersion); Windows=$runningOnWindows). No live deployment was performed."
}
finally {
    foreach ($entry in $savedEnvironment.GetEnumerator()) {
        [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value)
    }
    [System.Net.ServicePointManager]::SecurityProtocol = $originalTls
    [Console]::InputEncoding = $originalInputEncoding
    [Console]::SetIn($originalInputReader)
    [System.IO.Directory]::Delete($testDirectory, $true)
}
