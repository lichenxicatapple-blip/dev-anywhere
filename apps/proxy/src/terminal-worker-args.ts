import { z } from "zod";
import {
  PTY_INITIAL_MAX_COLS,
  PTY_INITIAL_MAX_ROWS,
  PTY_INITIAL_MIN_COLS,
  PTY_INITIAL_MIN_ROWS,
} from "@dev-anywhere/shared";
import type { ProviderHookContext, ProviderId } from "./providers/types.js";

export interface TerminalWorkerCliArgs {
  sessionId: string;
  kind: "agent" | "terminal";
  provider: ProviderId;
}

export interface TerminalWorkerBootstrap {
  kind: "agent" | "terminal";
  provider: ProviderId;
  cwd: string;
  name: string;
  cols: number;
  rows: number;
  args: string[];
  permissionMode?: string;
  nativeSessionId?: string;
  shell?: string;
  hook?: ProviderHookContext;
}

export function parseTerminalWorkerCliArgs(argv: readonly string[]): TerminalWorkerCliArgs | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.indexOf("=");
    const key = separator < 0 ? arg : arg.slice(0, separator);
    if (!["--profile", "--session", "--kind", "--provider"].includes(key) || values.has(key))
      return null;
    const value = separator < 0 ? argv[++index] : arg.slice(separator + 1);
    if (!value || value.startsWith("--")) return null;
    values.set(key, value);
  }
  const sessionId = values.get("--session");
  const kind = values.get("--kind");
  const provider = values.get("--provider");
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  if (kind !== "agent" && kind !== "terminal") return null;
  if (provider !== "claude" && provider !== "codex" && provider !== "kimi") return null;
  if (kind === "terminal" && provider !== "claude") return null;
  return { sessionId, kind, provider };
}

const BootstrapSchema = z
  .object({
    kind: z.enum(["agent", "terminal"]),
    provider: z.enum(["claude", "codex", "kimi"]),
    cwd: z.string().min(1),
    name: z.string().min(1),
    cols: z.number().int().min(PTY_INITIAL_MIN_COLS).max(PTY_INITIAL_MAX_COLS),
    rows: z.number().int().min(PTY_INITIAL_MIN_ROWS).max(PTY_INITIAL_MAX_ROWS),
    args: z.array(z.string()).default([]),
    permissionMode: z.string().optional(),
    nativeSessionId: z.string().optional(),
    shell: z.string().optional(),
    hook: z
      .object({
        provider: z.enum(["claude", "codex"]),
        sessionId: z.string(),
        hookUrl: z.string(),
        marker: z.string(),
        token: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function parseTerminalWorkerBootstrap(
  raw: string,
  identity: TerminalWorkerCliArgs,
): TerminalWorkerBootstrap {
  const result = BootstrapSchema.parse(JSON.parse(raw));
  if (result.kind !== identity.kind || result.provider !== identity.provider) {
    throw new Error("Terminal worker bootstrap does not match its process identity");
  }
  if (
    result.hook &&
    (result.hook.sessionId !== identity.sessionId || result.hook.provider !== identity.provider)
  ) {
    throw new Error("Terminal worker hook does not match its process identity");
  }
  return result;
}
