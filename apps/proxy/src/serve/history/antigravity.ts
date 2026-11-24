import { homedir } from "node:os";
import type { SessionHistoryMessage } from "@dev-anywhere/shared";
import { AcpRpcError, AcpSession } from "../../providers/acp-session.js";
import { serviceLogger } from "../../common/logger.js";
import { asRecord } from "./files.js";
import { SAFE_SESSION_ID_PATTERN, type NativeHistorySession } from "./types.js";

export async function scanAntigravityHistory(
  env: NodeJS.ProcessEnv,
): Promise<NativeHistorySession[]> {
  const client = new AcpSession({
    provider: "antigravity",
    cwd: homedir(),
    env,
    // agy may spend several seconds opening its credential store on a cold start.
    requestTimeoutMs: 6_000,
  });
  try {
    const sessions = await client.listSessions();
    return sessions.flatMap((value) => {
      const session = asRecord(value);
      if (typeof session?.sessionId !== "string" || typeof session.cwd !== "string") return [];
      const updatedAt = typeof session.updatedAt === "string" ? Date.parse(session.updatedAt) : 0;
      return [
        {
          provider: "antigravity",
          id: session.sessionId,
          projectDir: session.cwd,
          title: typeof session.title === "string" ? session.title : undefined,
          updatedAt,
          kind: "unknown",
          hasConversation: true,
        },
      ];
    });
  } catch (error) {
    if (!(error instanceof AcpRpcError && error.code === -32000)) {
      serviceLogger.debug({ error: String(error) }, "Antigravity history unavailable");
    }
    return [];
  }
}

export async function readAntigravityMessages(
  sessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SessionHistoryMessage[]> {
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) return [];
  const messages: SessionHistoryMessage[] = [];
  let chunkRole: "user" | "assistant" | undefined;
  const client = new AcpSession({
    provider: "antigravity",
    cwd,
    env,
    onUpdate: (params) => {
      if (params.sessionId !== sessionId) return;
      const update = asRecord(params.update);
      const type = update?.sessionUpdate;
      if (type === "tool_call") chunkRole = undefined;
      if (type !== "user_message_chunk" && type !== "agent_message_chunk") return;
      const content = asRecord(update?.content);
      if (content?.type !== "text" || typeof content.text !== "string" || !content.text) return;
      const role = type === "user_message_chunk" ? "user" : "assistant";
      const previous = messages.at(-1);
      if (previous?.role === role && chunkRole === role) {
        previous.text += content.text;
      } else {
        messages.push({ role, text: content.text });
      }
      chunkRole = role;
    },
  });
  await client.loadHistory(sessionId);
  return messages;
}
