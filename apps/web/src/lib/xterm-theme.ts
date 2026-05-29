import type { ITheme } from "@xterm/xterm";
import type { ThemePreference } from "@/lib/theme-preference";

export type XtermThemeName = "light" | "dark";

// xterm.js 深色主题，与 app.css design tokens 对齐，ANSI 16 色来自 VS Code Dark+
export const xtermDarkTheme: ITheme = {
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

// 浅色主题使用适合浅底的高对比 ANSI 色；避免直接复用深色主题导致 yellow/white 不可读。
export const xtermLightTheme: ITheme = {
  background: "#F6F7F8",
  foreground: "#24292F",
  cursor: "#24292F",
  cursorAccent: "#F6F7F8",
  selectionBackground: "#BBDFFF",
  selectionForeground: undefined,
  black: "#24292F",
  red: "#CF222E",
  green: "#1A7F37",
  yellow: "#9A6700",
  blue: "#0969DA",
  magenta: "#8250DF",
  cyan: "#1B7C83",
  white: "#57606A",
  brightBlack: "#57606A",
  brightRed: "#A40E26",
  brightGreen: "#116329",
  brightYellow: "#7D4E00",
  brightBlue: "#0550AE",
  brightMagenta: "#6F42C1",
  brightCyan: "#055D68",
  brightWhite: "#1F2328",
};

export function getXtermTheme(name: XtermThemeName): ITheme {
  return name === "light" ? xtermLightTheme : xtermDarkTheme;
}

export function resolveXtermThemeName(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): XtermThemeName {
  if (preference === "auto") return systemPrefersDark ? "dark" : "light";
  return preference;
}
