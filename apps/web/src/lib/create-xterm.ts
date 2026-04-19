// xterm 工厂: DOM renderer 固定方案
// WebGL addon 在 snapshot 大批量 write 时只重绘 dirty set 里的 row, scrollback 推走的
// row 留在 framebuffer 为黑底 (mobile 窄视口尤其显眼). DOM renderer 走 _renderRows()
// 整 viewport 重绘, 稳定且 CJK/box-drawing 对齐目视无误差. Sarasa Fixed SC 随产品分发,
// 不依赖用户系统字体
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
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

  return {
    terminal,
    serializeAddon,
    dispose: () => terminal.dispose(),
  };
}
