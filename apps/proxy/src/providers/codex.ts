import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { RUN_DIR } from "../common/paths.js";
import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderHookContext,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";

const CODEX_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "PermissionRequest",
  "UserPromptSubmit",
  "SessionStart",
] as const;

// Codex hook configs also express command timeout as a finite value. Permission hooks should
// mirror native approval behavior and wait for the user, so avoid short provider defaults.
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
    requestId: payload.request_id || payload.requestId || payload.tool_use_id,
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

const HOOK_FORWARDER_PATH = `${RUN_DIR}/provider-hook-forwarder.mjs`;

function ensureHookForwarder(): string {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(HOOK_FORWARDER_PATH, `${HOOK_FORWARDER_SCRIPT}\n`, { mode: 0o600 });
  return HOOK_FORWARDER_PATH;
}

function buildHookForwardCommand(event: string): string {
  return `DEV_ANYWHERE_HOOK_EVENT=${event} node "$DEV_ANYWHERE_HOOK_FORWARDER"`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexHookEntry(event: string): string {
  const timeoutConfig =
    event === "PreToolUse" || event === "PermissionRequest"
      ? `, timeout=${PERMISSION_HOOK_TIMEOUT_SECONDS}`
      : ", timeout=5";
  return `${event}=[{matcher="", hooks=[{type="command", command=${tomlString(
    buildHookForwardCommand(event),
  )}${timeoutConfig}}]}]`;
}

function buildCodexHooksConfig(): string {
  return `hooks={${CODEX_HOOK_EVENTS.map((event) => buildCodexHookEntry(event)).join(", ")}}`;
}

function withCodexHookArgs(args: string[], context: ProviderHookContext | undefined): string[] {
  if (!context) return args;
  return ["-c", "features.codex_hooks=true", "-c", buildCodexHooksConfig(), ...args];
}

function withCodexHookEnv(
  env: NodeJS.ProcessEnv,
  context: ProviderHookContext | undefined,
): NodeJS.ProcessEnv {
  if (!context) return env;
  const forwarder = ensureHookForwarder();
  return {
    ...env,
    DEV_ANYWHERE_PROVIDER: context.provider,
    DEV_ANYWHERE_SESSION_ID: context.sessionId,
    DEV_ANYWHERE_HOOK_URL: context.hookUrl,
    DEV_ANYWHERE_HOOK_MARKER: context.marker,
    DEV_ANYWHERE_HOOK_TOKEN: context.token,
    DEV_ANYWHERE_HOOK_FORWARDER: forwarder,
  };
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv): string {
  const custom = env.CODEX_BIN;
  if (custom) return custom;
  try {
    return execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("codex not found in PATH. Set CODEX_BIN or install Codex CLI.");
  }
}

export const CODEX_PROVIDER: ProviderAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  capabilities: {
    supportsHooks: true,
    supportsSessionScopedConfig: true,
    supportsProjectScopedConfig: true,
    supportsGlobalSetup: true,
  },
  buildJsonCommand(_options: ProviderJsonOptions, _env: NodeJS.ProcessEnv): ProviderCommand {
    throw new Error("Codex JSON sessions are not supported yet; use PTY mode.");
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveCodexCommand(env),
      args: withCodexHookArgs(options.args, options.hook),
      env: withCodexHookEnv(env, options.hook),
    };
  },
};
