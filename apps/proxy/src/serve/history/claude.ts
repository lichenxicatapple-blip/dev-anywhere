import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { asRecord, readJsonlRecords } from "./files.js";
import { isConversationText, normalizeHistoryTitle } from "./title.js";
import { SAFE_SESSION_ID_PATTERN, type NativeHistorySession } from "./types.js";

function conversationText(value: string): string | null {
  const command = value.match(/<command-name>\s*(\/[^<]+?)\s*<\/command-name>/);
  if (command) {
    const args = value.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    value = `${command[1]}${args ? ` ${args}` : ""}`;
  }
  if (/^\s*<local-command-/.test(value)) return null;
  return isConversationText(value) ? value : null;
}

function readContent(value: unknown): { hasConversation: boolean; title?: string } {
  if (typeof value === "string") {
    const text = conversationText(value);
    return text
      ? {
          hasConversation: true,
          ...(normalizeHistoryTitle(text) !== null ? { title: text } : {}),
        }
      : { hasConversation: false };
  }
  if (!Array.isArray(value)) return { hasConversation: false };
  const texts: string[] = [];
  let hasText = false;
  let hasImage = false;
  for (const item of value) {
    const part = asRecord(item);
    if (part?.type === "text" && typeof part.text === "string") {
      const text = conversationText(part.text);
      if (text) {
        hasText = true;
        if (normalizeHistoryTitle(text) !== null) texts.push(text);
      }
    }
    if (part?.type === "image") {
      const source = asRecord(part.source);
      hasImage ||= typeof source?.data === "string" && source.data.length > 0;
      hasImage ||= typeof source?.url === "string" && source.url.length > 0;
    }
  }
  return {
    hasConversation: hasImage || hasText,
    ...(texts.length ? { title: texts.join("\n") } : {}),
  };
}

/** Claude's project encoding is a storage key, not a reversible working-directory path. */
export async function scanClaudeHistory(root: string): Promise<NativeHistorySession[]> {
  const result: NativeHistorySession[] = [];
  let projects;
  try {
    if (!(await lstat(root)).isDirectory()) return result;
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name);
    let files;
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const id = file.name.slice(0, -6);
      if (!SAFE_SESSION_ID_PATTERN.test(id)) continue;
      const path = join(directory, file.name);
      try {
        const info = await lstat(path);
        if (!info.isFile()) continue;
        const session: NativeHistorySession = {
          provider: "claude",
          id,
          updatedAt: info.mtimeMs,
          kind: "unknown",
          hasConversation: false,
        };
        for await (const record of readJsonlRecords(path)) {
          if (record.isSidechain === true) {
            session.kind = "internal";
            break;
          }
          if (record.isSidechain === false) session.kind = "main";
          if (typeof record.cwd === "string" && isAbsolute(record.cwd))
            session.projectDir ??= record.cwd;
          if (record.isMeta === true || (record.type !== "user" && record.type !== "assistant"))
            continue;
          const message = asRecord(record.message);
          const content = readContent(message ? message.content : record.message);
          session.hasConversation ||= content.hasConversation;
          if (record.type === "user" && content.title) session.title ??= content.title;
          if (
            session.kind === "main" &&
            session.projectDir &&
            session.title &&
            session.hasConversation
          )
            break;
        }
        result.push(session);
      } catch {
        // A disappearing or unreadable native file must not hide other sessions.
      }
    }
  }
  return result;
}
