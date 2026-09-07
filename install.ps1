# Windows PowerShell 5.1 and PowerShell 7 online deployment entry point.
# The target VPS must run Linux. Only native OpenSSH is needed locally.
[CmdletBinding()]
param(
    [string]$SshTarget,
    [string]$PublicHost,
    [switch]$Help
)

# Keep preferences and helper functions local when invoked with irm ... | iex.
& {
    param($SshTarget, $PublicHost, $Help)

    Set-StrictMode -Version 2.0
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    function ConvertTo-RelayShellLiteral {
        param([AllowEmptyString()][string]$Value)
        if ($Value.IndexOf([char]0) -ge 0) {
            throw 'Installer arguments must not contain NUL characters.'
        }
        # A POSIX single quote is represented by ending the quoted string,
        # escaping one quote, and reopening it. No user input is evaluated.
        $escapedQuote = "'" + '\' + "''"
        return "'" + $Value.Replace("'", $escapedQuote) + "'"
    }

    function ConvertTo-RelayNativeArgument {
        param([AllowEmptyString()][string]$Value)
        # ProcessStartInfo.Arguments uses Windows argv quoting on .NET Framework.
        # Use it explicitly instead of PowerShell 5.1's native argument binder.
        $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        return '"' + $escaped + '"'
    }

    function Get-RelayRemoteCommand {
        # SSH sees only this fixed command. Arguments and configuration arrive
        # in stdin, so tokens never appear in the SSH process command line.
        # Check the byte count as well as syntax: an interrupted stream can end
        # at a syntactically valid prefix of the installer.
        return (@'
sh -c 'set -eu; if [ "$(uname -s)" != Linux ]; then printf "%s\n" "error: the target VPS must run Linux" >&2; exit 1; fi; command -v bash >/dev/null 2>&1 || { printf "%s\n" "error: bash is required on the target VPS" >&2; exit 1; }; umask 077; payload=$(mktemp /tmp/dev-anywhere-install.XXXXXXXXXX); trap "rm -f -- \"$payload\"" 0; trap "exit 1" 1 2 3 15; IFS= read -r expected_size; case "$expected_size" in ""|*[!0-9]*) printf "%s\n" "error: invalid installer transfer" >&2; exit 1;; esac; cat > "$payload"; if [ "$(wc -c < "$payload")" -ne "$expected_size" ]; then printf "%s\n" "error: incomplete installer transfer" >&2; exit 1; fi; bash -n "$payload"; if [ "$(id -u)" -eq 0 ]; then bash "$payload"; else sudo -n bash "$payload"; fi'
'@).Trim()
    }

    function Invoke-RelaySsh {
        param([string]$SshPath, [string]$Target, [byte[]]$Payload)

        $remoteCommand = Get-RelayRemoteCommand
        $nativeArguments = @('-T', '--', $Target, $remoteCommand) | ForEach-Object {
            ConvertTo-RelayNativeArgument $_
        }
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $SshPath
        $startInfo.Arguments = $nativeArguments -join ' '
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardInput = $true
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        try {
            if (-not $process.Start()) {
                throw 'Could not start OpenSSH.'
            }
            $writeError = $null
            try {
                $header = [System.Text.Encoding]::ASCII.GetBytes(
                    $Payload.Length.ToString([System.Globalization.CultureInfo]::InvariantCulture) + "`n"
                )
                # Write bytes directly: Windows PowerShell otherwise defaults
                # native pipelines to ASCII and can alter non-ASCII token text.
                $process.StandardInput.BaseStream.Write($header, 0, $header.Length)
                $process.StandardInput.BaseStream.Write($Payload, 0, $Payload.Length)
            }
            catch {
                $writeError = $_
            }
            finally {
                $process.StandardInput.Close()
            }
            $process.WaitForExit()
            if ($process.ExitCode -ne 0) {
                throw "SSH deployment failed (exit code $($process.ExitCode))."
            }
            if ($null -ne $writeError) {
                throw 'Could not send the complete installer to OpenSSH.'
            }
        }
        finally {
            $process.Dispose()
        }
    }

    function Install-DevAnywhereRelay {
        param([string]$SshTarget, [string]$PublicHost)

        $ssh = Get-Command ssh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $ssh) {
            throw 'OpenSSH client was not found. Enable the Windows OpenSSH Client optional feature, then run this command again.'
        }
        if ([string]::IsNullOrWhiteSpace($SshTarget)) {
            $SshTarget = Read-Host 'SSH destination (for example root@203.0.113.10)'
        }
        if ([string]::IsNullOrWhiteSpace($PublicHost)) {
            $PublicHost = Read-Host 'Public domain or IPv4 address (without https:// or a port)'
        }
        # Destination is a separate native argv item, never remote shell code.
        if ([string]::IsNullOrWhiteSpace($SshTarget) -or $SshTarget.StartsWith('-') -or $SshTarget -match '[\s\x00-\x1f\x7f]') {
            throw 'SSH destination must be a host or user@host and must not start with a dash or contain whitespace.'
        }
        if ([string]::IsNullOrWhiteSpace($PublicHost)) {
            throw 'A public domain or IPv4 address is required.'
        }

        # Build these first so invalid arguments fail before any download.
        $settings = @('set -euo pipefail')
        foreach ($name in @('REGISTRY_BASE', 'IMAGE_TAG', 'DEV_ANYWHERE_RELAY_PORT')) {
            $value = [System.Environment]::GetEnvironmentVariable($name)
            if ($null -eq $value) { $value = '' }
            $settings += 'export ' + $name + '=' + (ConvertTo-RelayShellLiteral $value)
        }
        $settings += 'set -- ' + (ConvertTo-RelayShellLiteral $PublicHost)

        $downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('dev-anywhere-install-' + [guid]::NewGuid().ToString('N'))
        $null = [System.IO.Directory]::CreateDirectory($downloadDirectory)
        $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $previousTls = [System.Net.ServicePointManager]::SecurityProtocol
        try {
            # Older Windows PowerShell sessions may default to TLS 1.0. This
            # process setting is restored even when a download fails.
            [System.Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [System.Net.SecurityProtocolType]::Tls12
            $repository = 'lichenxicatapple-blip/dev-anywhere'
            $revisionPath = Join-Path $downloadDirectory 'revision.txt'
            Invoke-WebRequest -UseBasicParsing -Uri "https://api.github.com/repos/$repository/commits/main" `
                -Headers @{ Accept = 'application/vnd.github.sha' } -UserAgent 'dev-anywhere-installer' `
                -OutFile $revisionPath -TimeoutSec 60 -ErrorAction Stop
            $revision = [System.IO.File]::ReadAllText($revisionPath, $utf8).Trim()
            if ($revision -notmatch '\A[0-9a-fA-F]{40}\z') {
                throw 'GitHub did not return a valid commit SHA. No installer was executed.'
            }

            $downloadedScripts = @()
            foreach ($relativePath in @('scripts/lib/install-relay-render.sh', 'scripts/deploy/install-relay.sh')) {
                $destination = Join-Path $downloadDirectory ([System.IO.Path]::GetFileName($relativePath))
                Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/$repository/$revision/$relativePath" `
                    -UserAgent 'dev-anywhere-installer' `
                    -OutFile $destination -TimeoutSec 60 -ErrorAction Stop
                $scriptText = [System.IO.File]::ReadAllText($destination, $utf8)
                if ([string]::IsNullOrWhiteSpace($scriptText)) {
                    throw "Downloaded installer component is empty: $relativePath. No installer was executed."
                }
                $downloadedScripts += $scriptText.Replace("`r`n", "`n")
            }
            $payloadText = ($settings -join "`n") + "`n" + ($downloadedScripts -join "`n") + "`n"
            $payload = $utf8.GetBytes($payloadText)
        }
        finally {
            [System.Net.ServicePointManager]::SecurityProtocol = $previousTls
            [System.IO.Directory]::Delete($downloadDirectory, $true)
        }

        Write-Host "==> deploying commit $revision to $SshTarget"
        Invoke-RelaySsh -SshPath $ssh.Source -Target $SshTarget -Payload $payload
    }

    if ($Help) {
        @'
Deploy or upgrade DEV Anywhere on a Linux VPS from Windows PowerShell 5.1 or PowerShell 7.

Interactive one-line installation:
  irm https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.ps1 | iex

One-line installation with an explicit destination:
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.ps1))) -SshTarget root@203.0.113.10 -PublicHost relay.example.com

Parameters: -SshTarget, -PublicHost, -Help.
Environment overrides: IMAGE_TAG, REGISTRY_BASE, DEV_ANYWHERE_RELAY_PORT.
Requires the native OpenSSH client and SSH access to a Linux VPS.
Root needs no sudo; other remote accounts need passwordless sudo (sudo -n).
Git, Bash, WSL, and PowerShell 7 are not required on Windows.
'@
        return
    }

    Install-DevAnywhereRelay -SshTarget $SshTarget -PublicHost $PublicHost
} @PSBoundParameters
