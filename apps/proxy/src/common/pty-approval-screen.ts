const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

type ApprovalScreenProvider = "claude" | "codex";
export type PtyApprovalScreenState = "waiting" | "resolved";

const DETECTION_TAIL_LINES = 14;

const PROVIDER_PATTERNS: Record<ApprovalScreenProvider, readonly RegExp[]> = {
  claude: [
    /Claude needs your permission to use/i,
    /Do you want to .*?\?\s*(?:[>›❯]\s*)?1\.\s*Yes\s*2\.\s*Yes.*?3\.\s*No/i,
  ],
  codex: [
    /Allow Codex to run `.*?` in /i,
    /Would you like to run the following command\?/i,
    /Would you like to make the following edits\?/i,
    /Would you like to grant these permissions\?/i,
    /Do you want to approve network access to "/i,
    /Tool call needs your approval/i,
    /needs your approval\./i,
  ],
};

const PROVIDER_RESOLVED_PATTERNS: Record<ApprovalScreenProvider, readonly RegExp[]> = {
  claude: [
    /User rejected\b/i,
    /User approved\b/i,
    /User denied\b/i,
    /User cancelled\b/i,
    /permission denied/i,
  ],
  codex: [/\bapproved\b/i, /\bdenied\b/i, /\brejected\b/i, /\bcancelled\b/i, /permission denied/i],
};

export function stripTerminalControls(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function tailVisibleText(text: string): string {
  return stripTerminalControls(text).split(/\r?\n/).slice(-DETECTION_TAIL_LINES).join("\n");
}

export function hasPtyApprovalPrompt(text: string, provider: ApprovalScreenProvider): boolean {
  return detectPtyApprovalScreen(text, provider) === "waiting";
}

function lastPatternIndex(text: string, patterns: readonly RegExp[]): number {
  let last = -1;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(text)) !== null) {
      last = Math.max(last, match.index);
      if (match[0].length === 0) globalPattern.lastIndex += 1;
    }
  }
  return last;
}

export function detectPtyApprovalScreen(
  text: string,
  provider: ApprovalScreenProvider,
): PtyApprovalScreenState | null {
  const tail = tailVisibleText(text).replace(/\s+/g, " ");
  const waitingIndex = lastPatternIndex(tail, PROVIDER_PATTERNS[provider]);
  const resolvedIndex = lastPatternIndex(tail, PROVIDER_RESOLVED_PATTERNS[provider]);
  if (waitingIndex < 0 && resolvedIndex < 0) return null;
  return resolvedIndex > waitingIndex ? "resolved" : "waiting";
}
