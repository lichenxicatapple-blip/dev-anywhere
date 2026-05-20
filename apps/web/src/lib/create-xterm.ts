// xterm 工厂: WebGL renderer
// WebGL 按 cell 坐标直接绘制, 不依赖 DOM letter-spacing 补偿, CJK/box-drawing 对齐稳定.
// Sarasa Fixed SC 随产品分发, 不依赖用户系统字体
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@/lib/chat-font-size";
import { xtermTheme } from "@/lib/xterm-theme";
import { getPtyDebug, type PtyRendererKind } from "@/lib/pty-render-debug";

interface CreateXtermResult {
  terminal: Terminal;
  serializeAddon: SerializeAddon;
  renderer: PtyRendererKind;
  // webgl 模式下返回当前活动的 addon ref;DOM renderer 时为 null。
  // 暴露给 pty-render-state-probe 走形状探测拿 _renderer._model.cells 做 diff。
  getWebglAddon: () => WebglAddon | null;
  // 重置 WebGL 最终 paint 层: 清 texture atlas 并全量 refresh。
  // 这条路径专门覆盖 model/buffer 一致但屏幕像素错乱的运行时坏状态。
  resetWebglPaint: () => boolean;
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
    theme: xtermTheme,
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

  // 渲染器选择：默认 webgl（按 cell 坐标稳定对齐 CJK），但 __devAnywherePtyRenderDebug.setRenderer("dom")
  // 可以在不重新发布的情况下切回 DOM renderer——用来在出现 cell 叠字 / atlas 残留这类
  // 难定位的渲染问题时做对比验证（DOM renderer 不依赖 GPU atlas）。
  const requested = getPtyDebug().getRenderer();
  let webglAddon: WebglAddon | null = null;
  let webglDisposed = false;
  let activeRenderer: PtyRendererKind = "dom";

  function resetWebglPaint(): boolean {
    if (webglDisposed || !webglAddon || terminal.rows <= 0) return false;
    try {
      webglAddon.clearTextureAtlas();
      terminal.refresh(0, terminal.rows - 1);
      return true;
    } catch (err) {
      console.warn("WebGL paint reset failed", err);
      return false;
    }
  }

  // Sarasa Fixed SC 是 cn-font-split 切片字体, 按 unicode-range 懒加载 — shard 直到首次出现
  // 对应字符才会被 fetch。await document.fonts.ready 在 xterm 创建时只能等"已声明的字体",
  // 此时 shard 都还没被请求, fonts.ready 立刻 resolve, WebGL atlas 用 fallback glyph 把那
  // 几格 (• U+2022 / ❯ ▣ 等 claude-code 状态字符) cache 成错的纹理; 后续 shard 到达后,
  // atlas 不刷不会重画。重进会话才"正常"是因为 shard 已在浏览器缓存里, atlas 第一次构建就对。
  // 监听 document.fonts.loadingdone, 每批字体落定后 clear atlas, 让下一帧用真字体重绘。
  const onFontsLoadingDone = (): void => {
    resetWebglPaint();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") resetWebglPaint();
  };
  const onPageShow = (): void => {
    resetWebglPaint();
  };
  const onWindowFocus = (): void => {
    resetWebglPaint();
  };
  document.fonts.addEventListener("loadingdone", onFontsLoadingDone);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("focus", onWindowFocus);

  function loadWebgl(): void {
    if (webglDisposed) return;
    try {
      const addon = new WebglAddon();
      // GPU context 被回收时（标签页休眠 / 系统休眠 / GPU 进程崩溃），旧 atlas 的 texture
      // handle 全部失效但 xterm 内部状态没刷新；不重载会持续画错 glyph。
      addon.onContextLoss(() => {
        addon.dispose();
        webglAddon = null;
        loadWebgl();
      });
      terminal.loadAddon(addon);
      webglAddon = addon;
      activeRenderer = "webgl";
    } catch (err) {
      console.warn("WebGL addon failed, fallback to DOM renderer", err);
      activeRenderer = "dom";
    }
  }

  if (requested === "webgl") {
    loadWebgl();
  } else {
    // 不加 webgl addon = xterm 走内置 DOM renderer
    activeRenderer = "dom";
  }

  return {
    terminal,
    serializeAddon,
    renderer: activeRenderer,
    getWebglAddon: () => webglAddon,
    resetWebglPaint,
    dispose: () => {
      webglDisposed = true;
      document.fonts.removeEventListener("loadingdone", onFontsLoadingDone);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onWindowFocus);
      webglAddon?.dispose();
      terminal.dispose();
    },
  };
}
