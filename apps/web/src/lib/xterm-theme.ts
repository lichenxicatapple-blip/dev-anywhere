import type { ITheme } from "@xterm/xterm";

// xterm.js 主题，与 app.css design tokens 对齐，ANSI 16 色来自 VS Code Dark+
export const xtermTheme: ITheme = {
  background: "#1E1E1E",
  foreground: "#D4D4D4",
  cursor: "#D4D4D4",
  cursorAccent: "#00D4AA",
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
