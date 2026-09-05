import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { asRecord, collectFilesNamed, readJsonlRecords } from "./files.js";
import { isConversationText, normalizeHistoryTitle } from "./title.js";
import { SAFE_SESSION_ID_PATTERN, type NativeHistorySession } from "./types.js";

function readContent(value: unknown): { hasConversation: boolean; title?: string } {
  if (typeof value === "string") {
    return isConversationText(value)
      ? { hasConversation: true, title: value }
      : { hasConversation: false };
  }
  if (!Array.isArray(value)) return { hasConversation: false };
  const texts: string[] = [];
  let hasImage = false;
  for (const item of value) {
    const part = asRecord(item);
    if (part?.type === "text" && typeof part.text === "string" && isConversationText(part.text))
      texts.push(part.text);
    if (part?.type === "image_url") {
      const image = asRecord(part.image_url);
      hasImage ||= typeof image?.url === "string" && image.url.length > 0;
    }
    if (part?.type === "image") {
      hasImage ||= typeof part.data === "string" && part.data.length > 0;
    }
  }
  return {
    hasConversation: hasImage || texts.length > 0,
    ...(texts.length ? { title: texts.join("\n") } : {}),
  };
}

function conversationContent(record: Record<string, unknown>): unknown {
  if (record.agentId !== undefined && record.agentId !== "main") return null;
  if (record.type === "turn.prompt") {
    const origin = asRecord(record.origin);
    return origin?.kind === undefined || origin.kind === "user" ? record.input : null;
  }
  if (record.type === "context.append_message") {
    const message = asRecord(record.message);
    if (message?.role !== "user" && message?.role !== "assistant") return null;
    const origin = asRecord(message.origin);
    if (message.role === "user" && origin?.kind !== undefined && origin.kind !== "user")
      return null;
    return message.content;
  }
  if (record.type === "context.append_loop_event") {
    const event = asRecord(record.event);
    return event?.type === "content.part" ? [event.part] : null;
  }
  // The Wire event file stores its envelope under `message`; do not unwrap SubagentEvent.
  const message = asRecord(record.message);
  const payload = asRecord(message?.payload);
  if (message?.type === "TurnBegin") return payload?.user_input;
  if (message?.type === "ContentPart") return [payload];
  return null;
}

/** Only session state plus that session's main-agent wire can establish Kimi history. */
export async function scanKimiHistory(root: string): Promise<NativeHistorySession[]> {
  const result: NativeHistorySession[] = [];
  try {
    if (!(await lstat(root)).isDirectory()) return result;
  } catch {
    return result;
  }
  for (const path of await collectFilesNamed(root, "state.json")) {
    // Native layout: sessions/<workspace>/<session>/state.json, never agents/<id>/state.json.
    if (relative(root, path).split(sep).length !== 3) continue;
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      const state = asRecord(JSON.parse(await readFile(path, "utf8")));
      if (
        !state ||
        state.archived === true ||
        typeof state.id !== "string" ||
        !SAFE_SESSION_ID_PATTERN.test(state.id)
      )
        continue;
      const directory = dirname(path);
      if (basename(directory) !== state.id) continue;
      const updatedAt = [state.updatedAt, state.createdAt, info.mtimeMs].find(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      )!;
      const session: NativeHistorySession = {
        provider: "kimi",
        id: state.id,
        updatedAt,
        kind: "main",
        hasConversation: false,
      };
      if (typeof state.cwd === "string" && isAbsolute(state.cwd)) session.projectDir = state.cwd;
      for (const title of [state.title, state.lastPrompt]) {
        if (typeof title === "string" && normalizeHistoryTitle(title) !== null) {
          session.title = title;
          break;
        }
      }
      try {
        const agents = join(directory, "agents");
        const main = join(agents, "main");
        if ((await lstat(agents)).isDirectory() && (await lstat(main)).isDirectory()) {
          for await (const record of readJsonlRecords(join(main, "wire.jsonl"))) {
            const content = readContent(conversationContent(record));
            session.hasConversation ||= content.hasConversation;
            if (content.title && normalizeHistoryTitle(content.title) !== null)
              session.title ??= content.title;
            if (session.hasConversation && session.title) break;
          }
        }
      } catch {
        // State without readable conversation content is metadata, not a resumable conversation.
      }
      result.push(session);
    } catch {
      // One malformed state file must not hide the remaining native sessions.
    }
  }
  return result;
}
