// 消息信封类型镜像，与 shared/schemas/envelope.ts 保持一致，不依赖 zod

export type MessageSource = "proxy" | "client";

export type MessageType =
  | "user_input"
  | "assistant_message"
  | "thinking"
  | "tool_use_request"
  | "tool_approve"
  | "tool_deny"
  | "tool_result"
  | "session_create"
  | "session_list"
  | "session_switch"
  | "session_terminate"
  | "session_status"
  | "heartbeat"
  | "error"
  | "auth"
  | "sync_request"
  | "sync_response";

export interface MessageEnvelope {
  type: MessageType;
  sessionId: string;
  seq: number;
  timestamp: number;
  source: MessageSource;
  version: string;
  payload: Record<string, unknown>;
}

export type SessionState = "idle" | "working" | "waiting_approval" | "error" | "terminated";

export interface SessionInfo {
  sessionId: string;
  name?: string;
  state: SessionState;
  mode?: "pty" | "json";
}
