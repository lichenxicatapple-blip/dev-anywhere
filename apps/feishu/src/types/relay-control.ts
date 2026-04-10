// 中转服务器控制消息类型镜像，与 shared/schemas/relay-control.ts 保持一致，不依赖 zod
import type { TermSpan, TerminalFramePayload, PtyStatePayload } from "./terminal.js";

export interface ProxyInfo {
  proxyId: string;
  name?: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface CommandEntry {
  name: string;
  description: string;
  argumentHint?: string;
  source: string;
}

export interface HistorySession {
  id: string;
  title: string;
  projectDir: string;
  updatedAt: number;
}

// 所有控制消息的判别联合
export type RelayControlMessage =
  | { type: "proxy_list_response"; proxies: ProxyInfo[] }
  | { type: "client_register_response"; status: "restored" | "proxy_offline" | "new"; proxyId?: string; sessions?: Record<string, number> }
  | { type: "relay_error"; code: string; message: string }
  | { type: "dir_list_response"; entries: DirEntry[]; path: string }
  | { type: "command_list_push"; commands: CommandEntry[] }
  | { type: "file_tree_push"; path: string; entries: DirEntry[] }
  | { type: "session_history_response"; sessions: HistorySession[] }
  | { type: "proxy_offline"; proxyId: string }
  | { type: "proxy_online"; proxyId: string }
  | { type: "replay_response"; sessionId: string; messages: Record<string, unknown>[] }
  | { type: "gap_unrecoverable"; sessionId: string; fromSeq: number; toSeq: number }
  | { type: "terminal_frame"; sessionId: string; payload: TerminalFramePayload }
  | { type: "pty_state"; sessionId: string; payload: PtyStatePayload }
  | { type: "terminal_lines_response"; sessionId: string; fromLineId: number; oldestLineId: number; newestLineId: number; lines: TermSpan[][] };
