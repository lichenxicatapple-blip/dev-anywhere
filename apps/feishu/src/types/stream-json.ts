// Claude Code stream-json 事件类型镜像

export interface StreamJsonEvent {
  type: "system" | "assistant" | "user" | "result" | "control_request" | "stream_event";
  [key: string]: unknown;
}
