// 从 pages/pty-test.tsx 抽出的 xterm 工厂，Phase 9 锁定的配置 verbatim 复用
// ChatPtyView 与 pty-test 共享此函数，保证两处渲染行为一致
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

// 创建 xterm 实例并挂载到 container，配置与 Phase 9 /pty-test 一致
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

  // 必须在 terminal.open() 之后加载，WebGL renderer 按 cell 坐标直接绘制字符，
  // 不依赖 DOM letter-spacing 补偿，避免 CJK/box-drawing 错位
  try {
    const webglAddon = new WebglAddon();
    terminal.loadAddon(webglAddon);
  } catch (err) {
    console.warn("WebGL addon failed, fallback to DOM renderer", err);
  }

  return {
    terminal,
    serializeAddon,
    dispose: () => terminal.dispose(),
  };
}
