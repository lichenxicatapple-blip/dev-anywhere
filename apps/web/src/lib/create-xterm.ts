// xterm 工厂: WebGL renderer
// WebGL 按 cell 坐标直接绘制, 不依赖 DOM letter-spacing 补偿, CJK/box-drawing 对齐稳定.
// Sarasa Fixed SC 随产品分发, 不依赖用户系统字体
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { xtermTheme } from "@/lib/xterm-theme";

export interface CreateXtermResult {
  terminal: Terminal;
  serializeAddon: SerializeAddon;
  dispose: () => void;
}

// 创建 xterm 实例并挂载到 container
export async function createXtermTerminal(container: HTMLDivElement): Promise<CreateXtermResult> {
  await document.fonts.ready;

  const terminal = new Terminal({
    scrollback: 5000,
    fontFamily:
      '"Sarasa Fixed SC", "Noto Sans Mono CJK SC", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
    fontSize: 14,
    cursorBlink: false,
    cursorInactiveStyle: "none",
    disableStdin: true,
    theme: xtermTheme,
    allowProposedApi: true,
  });

  const serializeAddon = new SerializeAddon();
  const webLinksAddon = new WebLinksAddon();
  const unicodeAddon = new UnicodeGraphemesAddon();

  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.loadAddon(unicodeAddon);

  container.replaceChildren();
  terminal.open(container);

  // WebGL 必须在 terminal.open() 之后加载, 否则拿不到 canvas context
  try {
    terminal.loadAddon(new WebglAddon());
  } catch (err) {
    console.warn("WebGL addon failed, fallback to DOM renderer", err);
  }

  return {
    terminal,
    serializeAddon,
    dispose: () => terminal.dispose(),
  };
}
