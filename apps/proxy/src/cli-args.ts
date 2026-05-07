import type { ProviderId } from "./providers/index.js";

export function normalizeCliArgs(args: string[]): string[] {
  const normalized = [...args];
  while (normalized[0] === "--") {
    normalized.shift();
  }
  return normalized;
}

export function extractProviderArgs(args: string[]): { provider: ProviderId; args: string[] } {
  const providerFromEnv: ProviderId =
    process.env.DEV_ANYWHERE_PROVIDER === "codex" ? "codex" : "claude";
  const out: string[] = [];
  let provider = providerFromEnv;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      const next = args[i + 1];
      if (next === "claude" || next === "codex") {
        provider = next;
        i++;
        continue;
      }
    }
    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length);
      if (value === "claude" || value === "codex") {
        provider = value;
        continue;
      }
    }
    out.push(arg);
  }

  return { provider, args: out };
}
