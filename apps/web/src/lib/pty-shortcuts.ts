import type { TerminalShellFamily } from "@dev-anywhere/shared";
import type { SessionProvider } from "./session-provider";

export interface PtyShortcut {
  id: string;
  key: string;
  display: string;
  data: string;
  action?: string;
  mobileLabel?: string;
}

function key(
  id: string,
  name: string,
  display: string,
  data: string,
  action?: string,
): PtyShortcut {
  return { id, key: name, display, data, action };
}

const ctrlA = key("ctrl-a", "Ctrl+A", "^A", "\x01");
const ctrlB = key("ctrl-b", "Ctrl+B", "^B", "\x02");
const ctrlE = key("ctrl-e", "Ctrl+E", "^E", "\x05");
const ctrlK = key("ctrl-k", "Ctrl+K", "^K", "\x0b");
const ctrlL = key("ctrl-l", "Ctrl+L", "^L", "\x0c");
const ctrlO = key("ctrl-o", "Ctrl+O", "^O", "\x0f");
const ctrlR = key("ctrl-r", "Ctrl+R", "^R", "\x12");
const ctrlS = key("ctrl-s", "Ctrl+S", "^S", "\x13");
const ctrlT = key("ctrl-t", "Ctrl+T", "^T", "\x14");
const ctrlU = key("ctrl-u", "Ctrl+U", "^U", "\x15");
const ctrlW = key("ctrl-w", "Ctrl+W", "^W", "\x17");
const home = key("home", "Home", "Home", "\x1b[H");
const end = key("end", "End", "End", "\x1b[F");
const del = key("delete", "Delete", "Del", "\x1b[3~");
const f7 = key("f7", "F7", "F7", "\x1b[18~");
const f8 = key("f8", "F8", "F8", "\x1b[19~");

interface PtyShortcutPreset {
  menu: readonly PtyShortcut[];
  menuWithMobileControls?: readonly PtyShortcut[];
  mobileShiftTab?: PtyShortcut;
  // Keep four contextual positions within the 14-key toolbar. Prioritize viewing output,
  // recalling/editing prompts, and keys missing from phone keyboards. Every agent keeps
  // whole-draft clear in the third position; less frequent actions stay accessible in menu.
  mobile: readonly [PtyShortcut, PtyShortcut, PtyShortcut | "clear", PtyShortcut];
}

// Shortcut entries send raw keys. The separate "clear" action retains the agent's
// whole-draft clear behavior and its protection against repeated cancel/exit input.
// Defaults: https://code.claude.com/docs/en/interactive-mode
// https://learn.chatgpt.com/docs/developer-commands?surface=cli (Codex 0.159.2 /keymap)
// https://moonshotai.github.io/kimi-code/en/reference/keyboard.html
const shiftTab = key("shift-tab", "Shift+Tab", "⇧⇥", "\x1b[Z");
const ctrlD = key("ctrl-d", "Ctrl+D", "^D", "\x04");

// https://antigravity.google/docs/cli/using#keybindings
const antigravityDetails = { ...ctrlO, action: "工具详情", mobileLabel: "详情" };
const antigravityReview = { ...ctrlR, action: "审查产物", mobileLabel: "审查" };
const antigravityNewline = key("ctrl-j", "Ctrl+J", "^J", "\x0a", "换行");
const antigravityMode = { ...shiftTab, action: "切换模式", mobileLabel: "模式" };
// agy recognizes two explicit Escape sequences in one PTY write. Two bare ESC bytes
// sent together leave the draft in place.
const antigravityClear = key("clear", "Esc ×2", "Esc", "\x1b[27u\x1b[27u", "清空");
const antigravityEditing = [
  { ...ctrlA, action: "移到行首" },
  { ...ctrlE, action: "移到行尾" },
  key("ctrl-g", "Ctrl+G", "^G", "\x07", "在编辑器中打开"),
  { ...ctrlL, action: "清屏" },
];

const agentPresets: Record<SessionProvider, PtyShortcutPreset> = {
  claude: { menu: [ctrlO, ctrlR, ctrlT, ctrlS, ctrlB], mobile: [ctrlO, ctrlR, "clear", ctrlS] },
  codex: {
    menu: [
      ctrlT,
      ctrlR,
      // Match Codex's question hints. Alt+Up/Down are aliases for these actions.
      key("shift-left", "Shift+←", "⇧←", "\x1b[1;2D"),
      key("shift-right", "Shift+→", "⇧→", "\x1b[1;2C"),
      key("ctrl-bracket", "Ctrl+]", "^]", "\x1d"),
      key("shift-up", "Shift+↑", "⇧↑", "\x1b[1;2A"),
      key("shift-down", "Shift+↓", "⇧↓", "\x1b[1;2B"),
      // CSI-u distinguishes Ctrl+/ from the legacy 0x1f decoded as Ctrl+7 by Codex.
      key("ctrl-slash", "Ctrl+/", "^/", "\x1b[47;5u"),
    ],
    mobile: [ctrlT, ctrlR, "clear", ctrlK],
  },
  kimi: { menu: [ctrlO, ctrlE, ctrlT, ctrlS, ctrlB], mobile: [ctrlO, ctrlS, "clear", ctrlT] },
  antigravity: {
    menu: [
      antigravityDetails,
      antigravityReview,
      antigravityMode,
      antigravityNewline,
      antigravityClear,
      ...antigravityEditing,
    ],
    menuWithMobileControls: antigravityEditing,
    mobileShiftTab: antigravityMode,
    mobile: [antigravityDetails, antigravityReview, antigravityClear, antigravityNewline],
  },
  cursor: {
    menu: [shiftTab, ctrlR, ctrlD, ctrlT, ctrlS],
    mobile: [shiftTab, ctrlR, "clear", ctrlD],
  },
};

const emacsShell: PtyShortcutPreset = {
  menu: [ctrlR, ctrlA, ctrlE, ctrlW, ctrlL],
  mobile: [ctrlA, ctrlE, ctrlU, ctrlR],
};

const shellPresets: Record<TerminalShellFamily, PtyShortcutPreset> = {
  bash: emacsShell,
  zsh: emacsShell,
  fish: emacsShell,
  powershell: { menu: [ctrlR, home, end, ctrlW, ctrlL], mobile: [home, end, ctrlR, ctrlW] },
  cmd: {
    menu: [
      f7,
      f8,
      home,
      end,
      key("ctrl-left", "Ctrl+←", "^←", "\x1b[1;5D"),
      key("ctrl-right", "Ctrl+→", "^→", "\x1b[1;5C"),
    ],
    mobile: [home, end, f7, f8],
  },
};

const basicPreset: PtyShortcutPreset = {
  menu: [ctrlR, home, end, del],
  mobile: [home, end, ctrlR, del],
};

export function getPtyShortcutPreset(context: {
  kind?: "agent" | "terminal";
  provider?: SessionProvider;
  shellFamily?: TerminalShellFamily;
}): PtyShortcutPreset {
  if (context.kind === "terminal") {
    return context.shellFamily ? shellPresets[context.shellFamily] : basicPreset;
  }
  return context.provider ? agentPresets[context.provider] : basicPreset;
}
