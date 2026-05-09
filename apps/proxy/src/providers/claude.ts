import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderHookContext,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";
import { resolveExecutable } from "./path-resolver.js";

export type ClaudePermissionMode =
  | "default"
  | "auto"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

export function filterClaudeEnvVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("CLAUDECODE")) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function buildClaudeArgs(options: {
  outputFormat?: string;
  inputFormat?: string;
  permissionPromptTool?: string;
  permissionMode?: ClaudePermissionMode;
  forkSession?: boolean;
  resumeSessionId?: string;
  verbose?: boolean;
  includePartialMessages?: boolean;
}): string[] {
  const args: string[] = [];
  if (options.outputFormat) args.push("--output-format", options.outputFormat);
  if (options.inputFormat) args.push("--input-format", options.inputFormat);
  args.push("--permission-prompt-tool", options.permissionPromptTool ?? "stdio");
  args.push("--permission-mode", options.permissionMode ?? "default");
  if (options.verbose) args.push("--verbose");
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (options.forkSession !== false) args.push("--fork-session");
  if (options.includePartialMessages) args.push("--include-partial-messages");
  return args;
}

export function resolveClaudePtyCommand(env: NodeJS.ProcessEnv): string {
  return resolveExecutable(
    "claude",
    env,
    "CLAUDE_BIN",
    "claude not found in PATH. Set CLAUDE_BIN or install Claude Code: https://claude.ai/download",
  );
}

export function resolveClaudeJsonCommand(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_BIN || "claude";
}

const CLAUDE_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "PermissionRequest",
  "UserPromptSubmit",
  "SessionStart",
] as const;

// Claude Code hook schema uses a finite command timeout. Permission hooks must behave like
// native CLI approval and wait for the user, so use a deliberately long lease instead of
// allowing the provider default timeout to cut the request short.
const PERMISSION_HOOK_TIMEOUT_SECONDS = 365 * 24 * 60 * 60;

const HOOK_FORWARDER_SCRIPT = `
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", async () => {
  let payload = {};
  try { payload = body ? JSON.parse(body) : {}; } catch { payload = { raw: body }; }
  const request = {
    sessionId: process.env.DEV_ANYWHERE_SESSION_ID,
    provider: process.env.DEV_ANYWHERE_PROVIDER,
    marker: process.env.DEV_ANYWHERE_HOOK_MARKER,
    event: process.env.DEV_ANYWHERE_HOOK_EVENT || payload.hook_event_name || payload.event_name || "unknown",
    requestId: payload.request_id || payload.requestId,
    payload,
  };
  try {
    const response = await fetch(process.env.DEV_ANYWHERE_HOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + process.env.DEV_ANYWHERE_HOOK_TOKEN,
      },
      body: JSON.stringify(request),
    });
    process.stdout.write(await response.text());
  } catch {
    process.exit(0);
  }
});
`.trim();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildHookForwardCommand(event: string): string {
  return `DEV_ANYWHERE_HOOK_EVENT=${shellQuote(event)} node -e ${shellQuote(HOOK_FORWARDER_SCRIPT)}`;
}

export function buildClaudeHookSettings(options?: {
  includePermissionRequest?: boolean;
}): Record<string, unknown> {
  const includePermissionRequest = options?.includePermissionRequest ?? true;
  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    if (event === "PermissionRequest" && !includePermissionRequest) continue;
    hooks[event] = [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: buildHookForwardCommand(event),
            timeout: event === "PermissionRequest" ? PERMISSION_HOOK_TIMEOUT_SECONDS : 5,
          },
        ],
      },
    ];
  }
  return { hooks };
}

function withClaudeHookArgs(args: string[], context: ProviderHookContext | undefined): string[] {
  if (!context) return args;
  return [...args, "--settings", JSON.stringify(buildClaudeHookSettings())];
}

function withClaudeTerminalHookArgs(
  args: string[],
  context: ProviderHookContext | undefined,
): string[] {
  if (!context) return args;
  return [
    ...args,
    "--settings",
    JSON.stringify(buildClaudeHookSettings({ includePermissionRequest: false })),
  ];
}

function withClaudeTerminalPermissionArgs(args: string[], permissionMode?: string): string[] {
  if (!permissionMode) return args;
  return ["--permission-mode", permissionMode, ...args];
}

function withClaudeHookEnv(
  env: NodeJS.ProcessEnv,
  context: ProviderHookContext | undefined,
): NodeJS.ProcessEnv {
  if (!context) return env;
  return {
    ...env,
    DEV_ANYWHERE_PROVIDER: context.provider,
    DEV_ANYWHERE_SESSION_ID: context.sessionId,
    DEV_ANYWHERE_HOOK_URL: context.hookUrl,
    DEV_ANYWHERE_HOOK_MARKER: context.marker,
    DEV_ANYWHERE_HOOK_TOKEN: context.token,
  };
}

export const CLAUDE_PROVIDER: ProviderAdapter = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: {
    supportsHooks: true,
    supportsSessionScopedConfig: true,
    supportsProjectScopedConfig: true,
    supportsGlobalSetup: true,
  },
  buildJsonCommand(options: ProviderJsonOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    const baseArgs = buildClaudeArgs({
      outputFormat: "stream-json",
      inputFormat: "stream-json",
      permissionPromptTool: "stdio",
      permissionMode: options.permissionMode as ClaudePermissionMode | undefined,
      verbose: true,
      forkSession: true,
      resumeSessionId: options.resumeSessionId,
      includePartialMessages: options.includePartialMessages,
    });

    return {
      command: resolveClaudeJsonCommand(env),
      args: [...withClaudeHookArgs(baseArgs, options.hook), ...(options.extraArgs ?? [])],
      env: withClaudeHookEnv(filterClaudeEnvVars(env), options.hook),
    };
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    const args = withClaudeTerminalPermissionArgs(options.args, options.permissionMode);
    return {
      command: resolveClaudePtyCommand(env),
      args: withClaudeTerminalHookArgs(args, options.hook),
      env: withClaudeHookEnv(env, options.hook),
    };
  },
};
