import type { TerminalShellFamily } from "@dev-anywhere/shared";
import type { SessionProvider } from "./session-provider";

export interface PtyShortcut {
  id: string;
  key: string;
  display: string;
  data: string;
}

function key(id: string, name: string, display: string, data: string): PtyShortcut {
  return { id, key: name, display, data };
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
  // Keep four contextual positions within the 14-key toolbar. Prioritize viewing output,
  // recalling/editing prompts, and keys missing from phone keyboards. Every agent keeps
  // whole-draft clear in the third position; less frequent actions stay accessible in menu.
  mobile: readonly [PtyShortcut, PtyShortcut, PtyShortcut | "clear", PtyShortcut];
}

// Shortcut entries send raw keys. The separate "clear" action retains the agent's
// whole-draft clear behavior and its protection against repeated cancel/exit input.
// Defaults: https://code.claude.com/docs/en/interactive-mode
// https://learn.chatgpt.com/docs/developer-commands?surface=cli (Codex 0.154.0 /keymap)
// https://moonshotai.github.io/kimi-code/en/reference/keyboard.html
const agentPresets: Record<SessionProvider, PtyShortcutPreset> = {
  claude: { menu: [ctrlO, ctrlR, ctrlT, ctrlS, ctrlB], mobile: [ctrlO, ctrlR, "clear", ctrlS] },
  codex: {
    menu: [
      ctrlT,
      ctrlR,
      key("alt-up", "Alt+↑", "⌥↑", "\x1b[1;3A"),
      key("alt-down", "Alt+↓", "⌥↓", "\x1b[1;3B"),
      key("ctrl-bracket", "Ctrl+]", "^]", "\x1d"),
    ],
    mobile: [ctrlT, ctrlR, "clear", ctrlK],
  },
  kimi: { menu: [ctrlO, ctrlE, ctrlT, ctrlS, ctrlB], mobile: [ctrlO, ctrlS, "clear", ctrlT] },
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
