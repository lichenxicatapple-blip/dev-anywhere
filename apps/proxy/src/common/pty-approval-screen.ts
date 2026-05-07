const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

type ApprovalScreenProvider = "claude" | "codex";

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

export function stripTerminalControls(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function tailVisibleText(text: string): string {
  return stripTerminalControls(text).split(/\r?\n/).slice(-DETECTION_TAIL_LINES).join("\n");
}

export function hasPtyApprovalPrompt(text: string, provider: ApprovalScreenProvider): boolean {
  const tail = tailVisibleText(text).replace(/\s+/g, " ");
  return PROVIDER_PATTERNS[provider].some((pattern) => pattern.test(tail));
}
