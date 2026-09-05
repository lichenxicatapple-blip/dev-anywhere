import { stat } from "node:fs/promises";
import { asRecord, collectJsonlFiles, readJsonlRecords } from "./files.js";
import { isConversationText, isCodexInjectedContextBlock, normalizeHistoryTitle } from "./title.js";
import { SAFE_SESSION_ID_PATTERN, type NativeHistorySession } from "./types.js";

function sessionKind(source: unknown): NativeHistorySession["kind"] {
  const descriptor = asRecord(source);
  if (source === "subagent" || (descriptor && "subagent" in descriptor)) {
    return "internal";
  }
  if (source === "cli" || source === "vscode" || source === "exec") return "main";
  return "unknown";
}

function conversationContent(payload: Record<string, unknown>): {
  hasConversation: boolean;
  title?: string;
} {
  if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) {
    return { hasConversation: false };
  }
  const texts: string[] = [];
  let hasImage = false;
  if (typeof payload.content === "string") texts.push(payload.content);
  else if (Array.isArray(payload.content)) {
    for (const value of payload.content) {
      const block = asRecord(value);
      if (!block) continue;
      if (block.type === "input_image" || block.type === "image") hasImage = true;
      if (
        (block.type === "input_text" || block.type === "output_text" || block.type === "text") &&
        typeof block.text === "string" &&
        !isCodexInjectedContextBlock(block.text)
      ) {
        texts.push(block.text);
      }
    }
  }
  const text = texts.filter(isConversationText).join("\n").trim();
  return {
    hasConversation: hasImage || Boolean(text),
    ...(payload.role === "user" && text ? { title: text } : {}),
  };
}

export async function readCodexSessionId(filePath: string): Promise<string | undefined> {
  for await (const row of readJsonlRecords(filePath)) {
    if (row.type !== "session_meta") continue;
    const id = asRecord(row.payload)?.id;
    return typeof id === "string" && SAFE_SESSION_ID_PATTERN.test(id) ? id : undefined;
  }
}

async function readCodexHistorySession(filePath: string): Promise<NativeHistorySession | null> {
  const info = await stat(filePath);
  let session: NativeHistorySession | null = null;
  for await (const row of readJsonlRecords(filePath)) {
    const payload = asRecord(row.payload);
    if (!payload) continue;
    if (row.type === "session_meta") {
      if (session) continue;
      if (typeof payload.id !== "string" || !SAFE_SESSION_ID_PATTERN.test(payload.id)) return null;
      session = {
        provider: "codex",
        id: payload.id,
        ...(typeof payload.cwd === "string" ? { projectDir: payload.cwd } : {}),
        updatedAt: info.mtimeMs,
        kind: sessionKind(payload.source),
        hasConversation: false,
      };
      // A user-created fork can have parent metadata too. Only the native source identifies
      // an internal agent; neither a parent ID nor a title is a reason to hide a conversation.
      if (session.kind === "internal") return session;
    } else if (session) {
      const message =
        row.type === "response_item"
          ? payload
          : row.type === "event_msg" &&
              (payload.type === "user_message" || payload.type === "agent_message")
            ? {
                type: "message",
                role: payload.type === "user_message" ? "user" : "assistant",
                content: payload.message,
              }
            : null;
      if (!message) continue;
      const content = conversationContent(message);
      session.hasConversation ||= content.hasConversation;
      if (content.title && normalizeHistoryTitle(content.title) !== null)
        session.title ??= content.title;
      if (session.hasConversation && session.title && session.projectDir) break;
    }
  }
  return session;
}

export async function scanCodexHistory(root: string): Promise<NativeHistorySession[]> {
  const sessions: NativeHistorySession[] = [];
  for (const filePath of await collectJsonlFiles(root)) {
    try {
      const session = await readCodexHistorySession(filePath);
      if (session) sessions.push(session);
    } catch {
      // A vanished or unreadable native file cannot provide a history entry.
    }
  }
  return sessions;
}
