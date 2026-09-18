import type { ProviderId } from "./providers/index.js";

const AGENT_CLI_INVOCATION_NAMES = new Set(["claude", "codex", "kimi", "cursor", "agent"]);

export function providerFromCliName(name: string | undefined): ProviderId | undefined {
  if (name === "claude" || name === "codex" || name === "kimi") return name;
  if (name === "cursor" || name === "agent") return "cursor";
  return undefined;
}

export function isAgentCliInvocationName(name: string | undefined): boolean {
  return typeof name === "string" && AGENT_CLI_INVOCATION_NAMES.has(name);
}

export function normalizeCliArgs(args: string[]): string[] {
  const normalized = [...args];
  while (normalized[0] === "--") {
    normalized.shift();
  }
  return normalized;
}

export function stripProxyProfileArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (isAgentCliInvocationName(arg)) {
      result.push(...args.slice(i));
      break;
    }
    if (arg === "--profile") {
      i++;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function extractAgentInvocation(args: string[]): { provider: ProviderId; args: string[] } {
  const [agent, ...providerArgs] = args;
  const provider = providerFromCliName(agent);
  if (!provider) {
    throw new Error(
      'Missing Agent CLI. Use "dev-anywhere claude ...", "dev-anywhere codex ...", "dev-anywhere kimi ...", or "dev-anywhere agent ...".',
    );
  }
  return { provider, args: providerArgs };
}
