import type { ProviderId } from "./providers/index.js";

export function normalizeCliArgs(args: string[]): string[] {
  const normalized = [...args];
  while (normalized[0] === "--") {
    normalized.shift();
  }
  return normalized;
}

export function extractAgentInvocation(args: string[]): { provider: ProviderId; args: string[] } {
  const [agent, ...providerArgs] = args;
  if (agent !== "claude" && agent !== "codex") {
    throw new Error(
      'Missing Agent CLI. Use "dev-anywhere claude ..." or "dev-anywhere codex ...".',
    );
  }
  return { provider: agent, args: providerArgs };
}
