// v1 终端栅格渲染类型，已从 shared 包移除
// feishu app 是遗留代码，v2 使用 xterm.js 替代栅格渲染
// 这些类型仅保留用于 feishu app 编译通过

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
  isScrolled?: boolean;
  anchorLineId?: number;
  newestLineId?: number;
}

export interface TerminalFrameDelta {
  mode: "delta";
  lines: Array<{ lineIndex: number; spans: TermSpan[] }>;
  cursor?: Cursor;
}

export type TerminalFramePayload = TerminalFrameFull | TerminalFrameDelta;
