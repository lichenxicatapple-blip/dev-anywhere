// 消息解析器，从 assistant_message.text 中提取 StreamJsonEvent 并路由到对应的 store action
import type { StreamJsonEvent } from "../types/stream-json.js";

// 尝试将 JSON 字符串解析为 StreamJsonEvent，失败返回 null
export function parseAssistantMessage(text: string): StreamJsonEvent | null {
  try {
    return JSON.parse(text) as StreamJsonEvent;
  } catch {
    return null;
  }
}

export type ChatAction =
  | { type: "APPEND_ASSISTANT_TEXT"; text: string }
  | { type: "MARK_TURN_COMPLETE" }
  | { type: "SET_CLAUDE_SESSION_ID"; id: string };

// 根据 StreamJsonEvent.type 路由到对应的 ChatAction
export function routeStreamEvent(event: StreamJsonEvent): ChatAction | null {
  switch (event.type) {
    case "assistant":
      return {
        type: "APPEND_ASSISTANT_TEXT",
        text: (event.text as string) ?? "",
      };
    case "result":
      return { type: "MARK_TURN_COMPLETE" };
    case "system":
      if (typeof event.session_id === "string") {
        return { type: "SET_CLAUDE_SESSION_ID", id: event.session_id };
      }
      return null;
    default:
      return null;
  }
}
