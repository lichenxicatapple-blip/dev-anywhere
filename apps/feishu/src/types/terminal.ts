// 终端栅格帧类型镜像，不依赖 zod，与 shared/schemas/session.ts 中的 TermSpan 保持一致

export interface TermSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export type TermLine = TermSpan[];

export interface Cursor {
  x: number;
  y: number;
}

export interface TerminalFrameFull {
  mode: "full";
  lines: TermLine[];
  cursor?: Cursor;
}

export interface TerminalFrameDelta {
  mode: "delta";
  lines: Array<{ lineIndex: number; spans: TermSpan[] }>;
  cursor?: Cursor;
}

export type TerminalFramePayload = TerminalFrameFull | TerminalFrameDelta;

export interface PtyStatePayload {
  state: "working" | "turn_complete" | "approval_wait";
  title?: string;
  tool?: string;
}
