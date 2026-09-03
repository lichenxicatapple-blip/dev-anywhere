import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WebPreviewTunnelStatus } from "@dev-anywhere/shared";
import { refreshLoginShellPath } from "../../common/login-shell-path.js";
import { findExecutableCandidates } from "../../providers/path-resolver.js";

const execFileAsync = promisify(execFile);
const CPOLAR_VERSION_TIMEOUT_MS = 5_000;
const CPOLAR_VERSION_OUTPUT_LIMIT_BYTES = 16 * 1024;
const SHARED_PATH_MAX_LENGTH = 4_096;
const SHARED_VERSION_MAX_LENGTH = 256;
const SHARED_SUGGESTION_MAX_COUNT = 32;

export type CpolarCapability = WebPreviewTunnelStatus;

interface LocatedCpolar {
  capability: CpolarCapability;
  command?: string;
  env: NodeJS.ProcessEnv;
}

interface CpolarLocatorOptions {
  baseEnv?: NodeJS.ProcessEnv;
  refreshPath?: typeof refreshLoginShellPath;
  findCandidates?: typeof findExecutableCandidates;
  verifyCommand?: (command: string, env: NodeJS.ProcessEnv) => Promise<string>;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "未找到 Cpolar";
  }
  return "Cpolar 无法运行";
}

function normalizeSuggestions(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || candidate.length > SHARED_PATH_MAX_LENGTH || seen.has(candidate)) continue;
    seen.add(candidate);
    suggestions.push(candidate);
    if (suggestions.length === SHARED_SUGGESTION_MAX_COUNT) break;
  }
  return suggestions;
}

async function verifyCpolar(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync(command, ["version"], {
    env,
    timeout: CPOLAR_VERSION_TIMEOUT_MS,
    maxBuffer: CPOLAR_VERSION_OUTPUT_LIMIT_BYTES,
    windowsHide: true,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return output.split(/\r?\n/, 1)[0]?.trim() || "cpolar";
}

export class CpolarLocator {
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly refreshPath: typeof refreshLoginShellPath;
  private readonly findCandidates: typeof findExecutableCandidates;
  private readonly verifyCommand: (command: string, env: NodeJS.ProcessEnv) => Promise<string>;
  private lastLocated: LocatedCpolar | null = null;

  constructor(options: CpolarLocatorOptions = {}) {
    this.baseEnv = { ...(options.baseEnv ?? process.env) };
    this.refreshPath = options.refreshPath ?? refreshLoginShellPath;
    this.findCandidates = options.findCandidates ?? findExecutableCandidates;
    this.verifyCommand = options.verifyCommand ?? verifyCpolar;
  }

  async inspect(options: { refreshPath?: boolean } = {}): Promise<LocatedCpolar> {
    if (!options.refreshPath && this.lastLocated?.capability.available) return this.lastLocated;

    const env = { ...this.baseEnv };
    if (options.refreshPath) {
      const refreshed = await this.refreshPath({ env });
      if (refreshed.path === undefined) delete env.PATH;
      else env.PATH = refreshed.path;
    }

    const suggestions = normalizeSuggestions(
      this.findCandidates(process.platform === "win32" ? "cpolar.exe" : "cpolar", env),
    );
    const command = suggestions[0];
    if (!command) {
      const located: LocatedCpolar = {
        capability: {
          available: false,
          error: "未找到 Cpolar",
          ...(suggestions.length > 0 ? { suggestions } : {}),
        },
        env,
      };
      this.lastLocated = located;
      return located;
    }

    try {
      const version =
        (await this.verifyCommand(command, env)).trim().slice(0, SHARED_VERSION_MAX_LENGTH) ||
        "cpolar";
      const located: LocatedCpolar = {
        capability: { available: true, command, version, suggestions },
        command,
        env,
      };
      this.lastLocated = located;
      return located;
    } catch (error) {
      const located: LocatedCpolar = {
        capability: {
          available: false,
          error: errorMessage(error),
          suggestions,
        },
        env,
      };
      this.lastLocated = located;
      return located;
    }
  }
}
