// xterm 工厂
// Sarasa Fixed SC 随产品分发, 不依赖用户系统字体
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import "@xterm/xterm/css/xterm.css";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@/lib/chat-font-size";
import { xtermDarkTheme } from "@/lib/xterm-theme";

interface CreateXtermResult {
  terminal: Terminal;
  serializeAddon: SerializeAddon;
  dispose: () => void;
}

interface CreateXtermOptions {
  fontSize?: number;
}

// 提到独立纯函数让单测可以直接断言关键 option 不被无意改回——尤其是
// cursorInactiveStyle: "none" (失焦时不画 ghost 光标)。
export function buildXtermTerminalOptions(options: CreateXtermOptions = {}): ITerminalOptions {
  return {
    scrollback: 5000,
    fontFamily:
      '"Sarasa Fixed SC", "Noto Sans Mono CJK SC", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
    fontSize: options.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
    cursorBlink: true,
    cursorStyle: "block",
    // 失焦时不渲染光标: "outline" 模式下 xterm 计算的 inactive 光标位置在长会话里会
    // 偏离当前 prompt, 视觉上是个孤立的空心方框落在错误格子上。失焦本就不接受输入,
    // 不显示更安全。
    cursorInactiveStyle: "none",
    disableStdin: false,
    theme: xtermDarkTheme,
    allowProposedApi: true,
  };
}

// 创建 xterm 实例并挂载到 container
export async function createXtermTerminal(
  container: HTMLDivElement,
  options: CreateXtermOptions = {},
): Promise<CreateXtermResult> {
  await document.fonts.ready;

  const terminal = new Terminal(buildXtermTerminalOptions(options));

  const serializeAddon = new SerializeAddon();
  const webLinksAddon = new WebLinksAddon();
  const unicodeAddon = new UnicodeGraphemesAddon();

  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.loadAddon(unicodeAddon);

  container.replaceChildren();
  terminal.open(container);

  // Sarasa Fixed SC 是 cn-font-split 切片字体, 按 unicode-range 懒加载 — shard 直到首次出现
  // 对应字符才会被 fetch。await document.fonts.ready 在 xterm 创建时只能等"已声明的字体",
  // 此时 shard 都还没被请求。监听 document.fonts.loadingdone, 每批字体落定后全量 refresh,
  // 让下一帧用真字体重绘。
  const onFontsLoadingDone = (): void => {
    terminal.refresh(0, terminal.rows - 1);
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") terminal.refresh(0, terminal.rows - 1);
  };
  const onPageShow = (): void => {
    terminal.refresh(0, terminal.rows - 1);
  };
  const onWindowFocus = (): void => {
    terminal.refresh(0, terminal.rows - 1);
  };
  document.fonts.addEventListener("loadingdone", onFontsLoadingDone);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("focus", onWindowFocus);

  return {
    terminal,
    serializeAddon,
    dispose: () => {
      document.fonts.removeEventListener("loadingdone", onFontsLoadingDone);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onWindowFocus);
      terminal.dispose();
    },
  };
}
