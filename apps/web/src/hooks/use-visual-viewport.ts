// iOS Safari 键盘适配: 用 visualViewport 计算 InputBar 应平移多少以贴紧键盘上方
// 桌面或不支持 visualViewport 的浏览器降级为 0, 配合 env(safe-area-inset-bottom)
import { useEffect, useRef, useState } from "react";

const VISUAL_VIEWPORT_HEIGHT_VAR = "--dev-visual-viewport-height";
const SOFT_KEYBOARD_VIEWPORT_RATIO = 0.78;

export interface VisualViewportBottomOffsetInput {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop: number;
  baselineViewportHeight: number;
}

export function computeVisualViewportBottomOffset({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
  baselineViewportHeight,
}: VisualViewportBottomOffsetInput): number {
  const currentBottomInset =
    layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop;
  const baselineBottomInset =
    baselineViewportHeight - visualViewportHeight - visualViewportOffsetTop;
  const currentRatio = visualViewportHeight / Math.max(layoutViewportHeight, 1);
  const baselineRatio = visualViewportHeight / Math.max(baselineViewportHeight, 1);

  const currentLooksLikeKeyboard =
    currentBottomInset > 0 && currentRatio < SOFT_KEYBOARD_VIEWPORT_RATIO;
  const baselineLooksLikeKeyboard =
    baselineBottomInset > 0 && baselineRatio < SOFT_KEYBOARD_VIEWPORT_RATIO;

  if (!currentLooksLikeKeyboard && !baselineLooksLikeKeyboard) return 0;
  return Math.max(currentBottomInset, baselineBottomInset, 0);
}

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
  const baselineHeightRef = useRef(0);
  const lastWidthRef = useRef(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const visualHeight = vv.height;
      const visualTop = vv.offsetTop;
      const visualWidth = vv.width;
      const observedHeight = Math.max(window.innerHeight, visualHeight + visualTop);

      // Some Android browsers resize window.innerHeight together with visualViewport.height
      // when the soft keyboard opens. Keep the largest pre-keyboard portrait baseline so
      // the keyboard still produces a bottom inset in that mode. Width changes reset the
      // baseline for orientation changes.
      if (!baselineHeightRef.current || Math.abs(visualWidth - lastWidthRef.current) > 1) {
        baselineHeightRef.current = observedHeight;
        lastWidthRef.current = visualWidth;
      } else {
        baselineHeightRef.current = Math.max(baselineHeightRef.current, observedHeight);
      }

      // iOS Safari also changes visualViewport for bottom browser chrome and the
      // hardware-keyboard accessory bar. Only treat large viewport compression as the
      // soft keyboard; otherwise we add padding that creates a visible dead zone above
      // the Safari address bar.
      setOffset(
        computeVisualViewportBottomOffset({
          layoutViewportHeight: window.innerHeight,
          visualViewportHeight: visualHeight,
          visualViewportOffsetTop: visualTop,
          baselineViewportHeight: baselineHeightRef.current,
        }),
      );
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
