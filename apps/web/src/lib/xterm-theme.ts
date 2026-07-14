import type { ITheme } from "@xterm/xterm";
import type { ISearchOptions } from "@xterm/addon-search";

export const XTERM_TERMINAL_PROFILE = "fixed-dark";
export const XTERM_ANSI16_COLOR_PROFILE = "vscode-dark-plus";

// PTY 渲染使用固定深色终端 profile, 不跟随 app 的浅色/深色主题。
// background/foreground/cursor 是终端外壳颜色; ANSI 16 色表只负责把
// SGR 30-37/90-97 这类索引颜色映射成 RGB。远端进程输出 truecolor 或
// ANSI background 时, 仍按远端自己的转义序列渲染。
export const xtermFixedDarkTheme: ITheme = {
  background: "#1E1E1E",
  foreground: "#D4D4D4",
  // PTY 模式已支持逐键输入，光标必须可见；未聚焦时由 xterm 的 outline 样式表达焦点状态。
  cursor: "#D4D4D4",
  cursorAccent: "#1E1E1E",
  selectionBackground: "#264F78",
  selectionForeground: undefined,
  black: "#000000",
  red: "#CD3131",
  green: "#0DBC79",
  yellow: "#E5E510",
  blue: "#2472C8",
  magenta: "#BC3FBC",
  cyan: "#11A8CD",
  white: "#E5E5E5",
  brightBlack: "#666666",
  brightRed: "#F14C4C",
  brightGreen: "#23D18B",
  brightYellow: "#F5F543",
  brightBlue: "#3B8EEA",
  brightMagenta: "#D670D6",
  brightCyan: "#29B8DB",
  brightWhite: "#E5E5E5",
};

export const xtermFixedDarkSearchDecorations: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#264F78",
  matchBorder: "#3B8EEA",
  matchOverviewRuler: "#3B8EEA",
  activeMatchBackground: "#7A4E00",
  activeMatchBorder: "#F5F543",
  activeMatchColorOverviewRuler: "#F5F543",
};
