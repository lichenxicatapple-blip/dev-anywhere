import { win32 } from "node:path";
import { environmentValue, normalizeProcessEnvironment } from "./executable.js";

// Run after the user's PowerShell profile has installed its prompt. Keep the
// existing prompt and report the FileSystem provider's location, not the process
// CWD (PowerShell does not update that when Set-Location runs).
const POWERSHELL_CWD_PROMPT = String.raw`
$global:DevAnywhereOriginalPrompt = $function:prompt
function global:prompt {
  $originalPrompt = & $global:DevAnywhereOriginalPrompt
  $location = $executionContext.SessionState.Path.CurrentLocation
  if ($location.Provider.Name -eq 'FileSystem') {
    [Console]::Write("$([char]27)]9;9;$($location.ProviderPath)$([char]27)\")
  }
  $originalPrompt
}
`;

export function buildTerminalShellCommand(
  shell: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (platform !== "win32") return { command: shell, args: [], env };
  const name = win32
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "powershell" || name === "pwsh") {
    return {
      command: shell,
      args: [
        "-NoLogo",
        "-NoExit",
        "-EncodedCommand",
        Buffer.from(POWERSHELL_CWD_PROMPT, "utf16le").toString("base64"),
      ],
      env,
    };
  }
  if (name === "cmd") {
    const prompt = environmentValue(env, "PROMPT", platform) ?? "$P$G";
    return {
      command: shell,
      args: [],
      env: {
        ...normalizeProcessEnvironment(env, platform),
        PROMPT: `$E]9;9;$P$E\\${prompt}`,
      },
    };
  }
  return { command: shell, args: [], env };
}
