import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";

export interface AutostartOptions {
  platform: NodeJS.Platform;
  home: string;
  profile: string;
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  uid?: number;
  username?: string;
  run?: (command: string, args: string[]) => Promise<string>;
}

export function autostartLabel(home: string, profile: string): string {
  return `dev-anywhere-${createHash("sha256").update(`${home}\0${profile}`).digest("hex").slice(0, 20)}`;
}

export function checkAutostartText(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) {
    throw new Error("Autostart paths and environment must not contain control characters");
  }
  return value;
}

export function xmlString(value: string): string {
  return checkAutostartText(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
}

/** Scalar directives such as User= and WorkingDirectory= do not remove shell quotes. */
export function unitValue(value: string): string {
  return checkAutostartText(value).replaceAll("%", "%%");
}

export function unitString(value: string): string {
  return `"${unitValue(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function psString(value: string): string {
  return `'${checkAutostartText(value).replaceAll("'", "''")}'`;
}

export async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
