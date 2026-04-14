// Claude Code stream-json 事件类型定义

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "thinking"; thinking: string };

export interface AssistantEvent {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    content: ContentBlock[];
    model?: string;
    stop_reason?: string | null;
  };
}

export interface SystemEvent {
  type: "system";
  subtype?: "init" | "hook_started" | "hook_response";
  session_id?: string;
  cwd?: string;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms?: number;
}

export interface UserEvent {
  type: "user";
  message?: { role: "user"; content: string };
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info?: Record<string, unknown>;
}

export type StreamJsonEvent =
  | AssistantEvent
  | SystemEvent
  | ResultEvent
  | UserEvent
  | RateLimitEvent;
