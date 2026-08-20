// xterm 工厂
// Sarasa Fixed SC 随产品分发, 不依赖用户系统字体
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import "@xterm/xterm/css/xterm.css";
import { DEFAULT_TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY } from "@/lib/chat-font-size";
import { loadFontCSS } from "@/lib/font-assets";
import { xtermFixedDarkTheme } from "@/lib/xterm-theme";

interface CreateXtermResult {
  terminal: Terminal;
  serializeAddon: SerializeAddon;
  dispose: () => void;
}

interface CreateXtermOptions {
  fontSize?: number;
}

// Codex renders `›` at the start of its input row and uses `·` / `•` in status text. Keep them in
// the preflight set: if a unicode-range shard arrives only after the DOM renderer has measured a
// fallback glyph, xterm keeps that fallback width and applies the wrong letter-spacing later.
// For `›`, that made a full-width prompt background end ~1.6 CSS px before the fixed row edge.
const TERMINAL_FONT_METRIC_GLYPHS = "─│╭╮╰╯›·•";

function refreshXtermFontMetrics(terminal: Terminal): void {
  // xterm 6's DOM WidthCache is not cleared by refresh(). A semantically identical font option
  // round-trip goes through its public options API and synchronously invalidates both the glyph
  // width cache and the base cell measurement after a lazy unicode-range shard finishes loading.
  const fontFamily = terminal.options.fontFamily;
  terminal.options.fontFamily = `${fontFamily} `;
  terminal.options.fontFamily = fontFamily;
  terminal.refresh(0, terminal.rows - 1);
}

// 提到独立纯函数让单测可以直接断言关键 option 不被无意改回——尤其是
// cursorInactiveStyle: "none" (失焦时不画 ghost 光标)。
export function buildXtermTerminalOptions(options: CreateXtermOptions = {}): ITerminalOptions {
  return {
    scrollback: 5000,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: options.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
    cursorBlink: true,
    cursorStyle: "block",
    // 失焦时不渲染光标: "outline" 模式下 xterm 计算的 inactive 光标位置在长会话里会
    // 偏离当前 prompt, 视觉上是个孤立的空心方框落在错误格子上。失焦本就不接受输入,
    // 不显示更安全。
    cursorInactiveStyle: "none",
    disableStdin: false,
    // PTY vertical geometry has one owner: pty-scroll-controller. xterm defaults this to true,
    // which makes every local keystroke jump viewportY to baseY before the controller restores
    // the semantic live viewport. A short server-owned host can legitimately follow at baseY - N,
    // so the two owners otherwise move host.top by whole rows on every character.
    scrollOnUserInput: false,
    // Desktop selection is application-owned so it can use the same absolute buffer range as
    // touch selection and the outer browser scroller. These xterm shortcuts would otherwise
    // create a second, hidden selection owner (Alt-click cursor movement also conflicts with the
    // conventional Alt rectangular-selection gesture).
    altClickMovesCursor: false,
    rightClickSelectsWord: false,
    theme: xtermFixedDarkTheme,
    allowProposedApi: true,
  };
}

// 创建 xterm 实例并挂载到 container
export async function createXtermTerminal(
  container: HTMLDivElement,
  options: CreateXtermOptions = {},
): Promise<CreateXtermResult> {
  // React passive effects run child-first, so the PTY can mount before useRelaySetup has appended
  // result.css. Waiting here makes the subsequent FontFaceSet.load an actual font request instead
  // of a successful no-op with zero matching @font-face rules.
  await loadFontCSS(window.location.origin);
  await document.fonts.ready;

  // split font 的框线字形默认按需加载。必须在 xterm DOM renderer 首次测量前请求，
  // 否则 renderer 会长期保留 fallback 字体的宽度缓存，单纯 refresh 也不会清掉。
  const fontSize = options.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
  try {
    await document.fonts.load(`${fontSize}px "Sarasa Fixed SC"`, TERMINAL_FONT_METRIC_GLYPHS);
  } catch {
    // 字体服务不可用时仍允许终端使用系统等宽字体启动。
  }

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
  // 此时其他 shard 都还没被请求。每批字体落定后要同时清掉 DOM renderer 的字宽
  // cache 并全量重绘；只调 refresh 会保留 fallback glyph 的旧 letter-spacing。
  const onFontsLoadingDone = (): void => {
    refreshXtermFontMetrics(terminal);
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
