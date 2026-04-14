// 消息解析器，从 assistant_message.text 中提取 StreamJsonEvent 并路由到对应的 store action
import type { StreamJsonEvent } from "@/types/stream-json";

// 从工具名和参数构建可读标题，截取路径最后两级或命令前 30 字符
export function formatToolTitle(name: string, input: Record<string, unknown>): string {
  const shortPath = (p: string) => {
    const parts = p.split("/").filter(Boolean);
    return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p;
  };
  const filePath = input.file_path as string | undefined;
  const command = input.command as string | undefined;
  const pattern = input.pattern as string | undefined;

  if (filePath) return `${name} ${shortPath(filePath)}`;
  if (command) return `${name}: ${command.length > 30 ? command.slice(0, 30) + "..." : command}`;
  if (pattern) return `${name}: ${pattern}`;
  return name;
}

// 尝试将 JSON 字符串解析为 StreamJsonEvent，失败返回 null
export function parseAssistantMessage(text: string): StreamJsonEvent | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.type !== "string") return null;
    return parsed as StreamJsonEvent;
  } catch {
    return null;
  }
}

export type ChatAction =
  | { type: "APPEND_ASSISTANT_TEXT"; text: string }
  | { type: "MARK_TURN_COMPLETE" }
  | { type: "SET_CLAUDE_SESSION_ID"; id: string }
  | { type: "SET_WORKING_TOOL"; toolName: string };

// 根据 StreamJsonEvent.type 路由到对应的 ChatAction
export function routeStreamEvent(event: StreamJsonEvent): ChatAction | null {
  switch (event.type) {
    case "assistant": {
      if (event.message.content.some((c) => c.type === "thinking")) {
        return { type: "SET_WORKING_TOOL", toolName: "Thinking..." };
      }
      const toolBlock = event.message.content.find((c) => c.type === "tool_use");
      if (toolBlock && toolBlock.type === "tool_use") {
        return { type: "SET_WORKING_TOOL", toolName: formatToolTitle(toolBlock.name, toolBlock.input) };
      }
      const text = event.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (!text) return null;
      return { type: "APPEND_ASSISTANT_TEXT", text };
    }
    case "result":
      return { type: "MARK_TURN_COMPLETE" };
    case "system":
      if (event.session_id) {
        return { type: "SET_CLAUDE_SESSION_ID", id: event.session_id };
      }
      return null;
    default:
      return null;
  }
}
