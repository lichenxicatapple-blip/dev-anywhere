import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface ExecutableLookupOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  isExecutableFile?: (path: string) => boolean;
}

/** Matches Node's case-insensitive Windows environment lookup without duplicate PATH keys. */
export function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env)
    .sort()
    .find((key) => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function normalizeProcessEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const normalized: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const key of Object.keys(env).sort()) {
    const lower = key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (env[key] !== undefined) normalized[key] = env[key];
  }
  return normalized;
}

export function isExecutableFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutableCandidates(
  name: string,
  env: NodeJS.ProcessEnv,
  options: ExecutableLookupOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const probe = options.isExecutableFile ?? ((file) => isExecutableFile(file, platform));
  const hasPath = windows ? /[\\/:]/.test(name) : name.includes("/");
  const extensions =
    windows && !win32.extname(name)
      ? (environmentValue(env, "PATHEXT", platform) || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim())
          .filter((ext) => /^\.[a-z0-9]+$/i.test(ext))
      : [""];
  const directories = hasPath
    ? [""]
    : (environmentValue(env, "PATH", platform) ?? "")
        .split(windows ? ";" : ":")
        .map((entry) => (windows ? entry.replace(/^"(.*)"$/, "$1") : entry))
        .filter(Boolean);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const directory of directories) {
    const base = directory ? path.join(directory, name) : name;
    for (const extension of extensions) {
      const file = path.resolve(options.cwd ?? process.cwd(), `${base}${extension}`);
      const key = windows ? file.toLowerCase() : file;
      if (seen.has(key)) continue;
      seen.add(key);
      if (probe(file)) candidates.push(file);
    }
  }
  return candidates;
}

export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return env.SHELL || "/bin/sh";
  return (
    environmentValue(env, "ComSpec", platform) ||
    win32.join(
      environmentValue(env, "SystemRoot", platform) || "C:\\Windows",
      "System32",
      "cmd.exe",
    )
  );
}
