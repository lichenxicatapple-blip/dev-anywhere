import { describe, expect, it, vi } from "vitest";
import { buildXtermTerminalOptions, createXtermTerminal } from "./create-xterm";
import { xtermDarkTheme } from "./xterm-theme";

describe("buildXtermTerminalOptions", () => {
  // 失焦光标走 "outline" 时, xterm 内部计算的 inactive 位置在长会话里会偏离当前
  // prompt, 视觉上是个孤立的空心方框落在错误格子。锁死 "none" 让失焦时不画。
  // 任何把这一项改回 outline / underline / block 的 PR 都会被这条测试拦下。
  it("disables the inactive cursor so a stale ghost cell can't render on blur", () => {
    const opts = buildXtermTerminalOptions();
    expect(opts.cursorInactiveStyle).toBe("none");
  });

  it("threads the caller's fontSize through to xterm", () => {
    expect(buildXtermTerminalOptions({ fontSize: 18 }).fontSize).toBe(18);
  });

  it("falls back to the project default fontSize when caller omits one", () => {
    const opts = buildXtermTerminalOptions();
    expect(opts.fontSize).toBeGreaterThan(0);
    expect(typeof opts.fontSize).toBe("number");
  });

  it("uses the terminal's dark default theme", () => {
    expect(buildXtermTerminalOptions().theme).toBe(xtermDarkTheme);
  });
});

describe("createXtermTerminal font invalidation", () => {
  // Sarasa Fixed SC 是 cn-font-split 切片字体,按 unicode-range 懒加载: shard 直到对应字符
  // 第一次出现才被 fetch。document.fonts.ready 此时已 resolve, WebGL atlas 用 fallback 锁了
  // 错的 glyph 纹理 (• 带黄底 / claude-code 状态字符 □□)。要在每批新字体落定后重置 atlas。
  it("subscribes to font and page lifecycle events and unsubscribes on dispose", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    // jsdom 不实现 FontFaceSet 也不实现 matchMedia, 都给 xterm/我们的代码塞最小桩。
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const fontsStub = {
      ready: Promise.resolve(),
      addEventListener,
      removeEventListener,
    };
    const originalFonts = (document as unknown as { fonts: unknown }).fonts;
    Object.defineProperty(document, "fonts", { value: fontsStub, configurable: true });
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })) as unknown as typeof window.matchMedia;
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");

    try {
      const result = await createXtermTerminal(container);

      const addedListeners = addEventListener.mock.calls.filter(
        (args) => args[0] === "loadingdone",
      );
      expect(addedListeners.length).toBe(1);
      const visibilityListeners = documentAdd.mock.calls.filter(
        (args) => args[0] === "visibilitychange",
      );
      expect(visibilityListeners.length).toBeGreaterThanOrEqual(1);
      const pageShowListeners = windowAdd.mock.calls.filter((args) => args[0] === "pageshow");
      expect(pageShowListeners.length).toBeGreaterThanOrEqual(1);
      const focusListeners = windowAdd.mock.calls.filter((args) => args[0] === "focus");
      expect(focusListeners.length).toBeGreaterThanOrEqual(1);
      // jsdom 没有 WebGL context,这里会走 DOM fallback。手动 reset 应该安全 no-op。
      expect(result.resetWebglPaint()).toBe(false);

      result.dispose();

      const removedListeners = removeEventListener.mock.calls.filter(
        (args) => args[0] === "loadingdone",
      );
      // 同一个 listener 函数引用必须被解绑, 避免 dispose 后 leak + 后续 clearTextureAtlas
      // 在已 dispose 的 webglAddon 上误触发。
      expect(removedListeners.length).toBe(1);
      expect(removedListeners[0][1]).toBe(addedListeners[0][1]);
      expect(
        documentRemove.mock.calls.some(
          (args) => args[0] === "visibilitychange" && args[1] === visibilityListeners.at(-1)?.[1],
        ),
      ).toBe(true);
      expect(
        windowRemove.mock.calls.some(
          (args) => args[0] === "pageshow" && args[1] === pageShowListeners.at(-1)?.[1],
        ),
      ).toBe(true);
      expect(
        windowRemove.mock.calls.some(
          (args) => args[0] === "focus" && args[1] === focusListeners.at(-1)?.[1],
        ),
      ).toBe(true);
    } finally {
      documentAdd.mockRestore();
      documentRemove.mockRestore();
      windowAdd.mockRestore();
      windowRemove.mockRestore();
      Object.defineProperty(document, "fonts", { value: originalFonts, configurable: true });
      window.matchMedia = originalMatchMedia;
      document.body.removeChild(container);
    }
  });
});
