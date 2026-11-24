import { homedir, platform } from "node:os";
import { join } from "node:path";

export const CURSOR_IDE_HISTORY_PREFIX = "cursor_ide_";

// Cursor injects these as a user turn when a background task finishes. They are not typed by the user.
export const CURSOR_TASK_RESULT_PROMPTS = [
  "Briefly inform the user about the task result and perform any follow-up actions (if needed).",
  "Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.",
];

export function isCursorTaskResultPrompt(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return CURSOR_TASK_RESULT_PROMPTS.includes(normalized);
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function cursorIdeNativeId(id: string): string | null {
  if (!id.startsWith(CURSOR_IDE_HISTORY_PREFIX)) return null;
  const nativeId = id.slice(CURSOR_IDE_HISTORY_PREFIX.length);
  return UUID.test(nativeId) ? nativeId : null;
}

export function cursorIdeUserDir(): string {
  if (process.env.CURSOR_IDE_USER_DIR) return process.env.CURSOR_IDE_USER_DIR;
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "Cursor", "User");
  if (platform() === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "User");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Cursor", "User");
}
