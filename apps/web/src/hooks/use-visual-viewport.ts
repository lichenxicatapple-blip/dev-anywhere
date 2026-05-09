// iOS Safari 键盘适配: 用 visualViewport 计算 InputBar 应平移多少以贴紧键盘上方
// 桌面或不支持 visualViewport 的浏览器降级为 0, 配合 env(safe-area-inset-bottom)
import { useEffect, useState } from "react";

const VISUAL_VIEWPORT_HEIGHT_VAR = "--dev-visual-viewport-height";
const SOFT_KEYBOARD_VIEWPORT_RATIO = 0.78;

export function useVisualViewportHeightVar(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    let raf = 0;

    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const height = vv?.height ?? window.innerHeight;
        document.documentElement.style.setProperty(VISUAL_VIEWPORT_HEIGHT_VAR, `${height}px`);
      });
    };

    update();
    window.addEventListener("resize", update);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR);
    };
  }, []);
}

export function useVisualViewportBottomOffset(): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const bottomOffset = window.innerHeight - vv.height - vv.offsetTop;
      const viewportRatio = vv.height / Math.max(window.innerHeight, 1);
      // iOS Safari also changes visualViewport for bottom browser chrome and the
      // hardware-keyboard accessory bar. Only treat large viewport compression
      // as the soft keyboard; otherwise we add padding that creates a visible
      // dead zone above the Safari address bar.
      const isLikelySoftKeyboard = viewportRatio < SOFT_KEYBOARD_VIEWPORT_RATIO;
      setOffset(isLikelySoftKeyboard ? Math.max(bottomOffset, 0) : 0);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    // 键盘关闭后 visualViewport 更新可能滞后, 失焦延迟 300ms 再采样一次
    const onBlur = () => {
      setTimeout(update, 300);
    };
    window.addEventListener("focusout", onBlur);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("focusout", onBlur);
    };
  }, []);

  return offset;
}
