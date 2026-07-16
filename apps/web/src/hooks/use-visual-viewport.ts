// iOS Safari 键盘适配: 用 visualViewport 计算 InputBar 应平移多少以贴紧键盘上方
// 桌面或不支持 visualViewport 的浏览器降级为 0, 配合 env(safe-area-inset-bottom)
import { useEffect, useRef, useState } from "react";

const VISUAL_VIEWPORT_HEIGHT_VAR = "--dev-visual-viewport-height";
const SOFT_KEYBOARD_MIN_OCCLUDED_VIEWPORT_SHARE = 0.3;

interface VisualViewportBottomOffsetInput {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop: number;
  baselineViewportHeight: number;
  allowBaselineFallback?: boolean;
}

export interface VisualViewportInsets {
  bottomOffset: number;
  layoutBottomInset: number;
}

export function computeVisualViewportBottomOffset({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
  baselineViewportHeight,
  allowBaselineFallback = true,
}: VisualViewportBottomOffsetInput): number {
  const currentBottomInset = layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop;
  const baselineBottomInset =
    baselineViewportHeight - visualViewportHeight - visualViewportOffsetTop;
  const currentKeyboardInset = softKeyboardInset(currentBottomInset, layoutViewportHeight);
  const baselineKeyboardInset = allowBaselineFallback
    ? softKeyboardInset(baselineBottomInset, baselineViewportHeight)
    : 0;
  return Math.max(currentKeyboardInset, baselineKeyboardInset);
}

export function computeVisualViewportLayoutBottomInset({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
  baselineViewportHeight = layoutViewportHeight,
  allowBaselineFallback = false,
}: Omit<VisualViewportBottomOffsetInput, "baselineViewportHeight"> &
  Partial<
    Pick<VisualViewportBottomOffsetInput, "baselineViewportHeight" | "allowBaselineFallback">
  >): number {
  return computeVisualViewportBottomOffset({
    layoutViewportHeight,
    visualViewportHeight,
    visualViewportOffsetTop,
    baselineViewportHeight,
    allowBaselineFallback,
  });
}

function softKeyboardInset(bottomInset: number, referenceViewportHeight: number): number {
  const inset = Math.max(bottomInset, 0);
  if (inset <= 0) return 0;
  const occludedShare = inset / Math.max(referenceViewportHeight, 1);
  // Browser chrome also changes visualViewport. Only substantial lower-screen
  // occlusion should move the app's keyboard layout.
  return occludedShare >= SOFT_KEYBOARD_MIN_OCCLUDED_VIEWPORT_SHARE ? inset : 0;
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

export function resetDocumentScrollIfNeeded(): boolean {
  const root = document.documentElement;
  const body = document.body;
  const needsReset =
    window.scrollX !== 0 ||
    window.scrollY !== 0 ||
    root.scrollLeft !== 0 ||
    root.scrollTop !== 0 ||
    body.scrollLeft !== 0 ||
    body.scrollTop !== 0;
  if (!needsReset) return false;

  window.scrollTo(0, 0);
  root.scrollLeft = 0;
  root.scrollTop = 0;
  body.scrollLeft = 0;
  body.scrollTop = 0;
  return true;
}

export function useDocumentScrollLock(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    let raf = 0;

    const scheduleReset = () => {
      resetDocumentScrollIfNeeded();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        resetDocumentScrollIfNeeded();
      });
    };

    scheduleReset();
    window.addEventListener("scroll", scheduleReset, { passive: true });
    window.addEventListener("resize", scheduleReset);
    vv?.addEventListener("scroll", scheduleReset, { passive: true });
    vv?.addEventListener("resize", scheduleReset);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", scheduleReset);
      window.removeEventListener("resize", scheduleReset);
      vv?.removeEventListener("scroll", scheduleReset);
      vv?.removeEventListener("resize", scheduleReset);
    };
  }, []);
}

export function useVisualViewportBottomOffset(): number {
  return useVisualViewportInsets().bottomOffset;
}

export function useVisualViewportInsets(): VisualViewportInsets {
  const [insets, setInsets] = useState<VisualViewportInsets>({
    bottomOffset: 0,
    layoutBottomInset: 0,
  });
  const baselineHeightRef = useRef(0);
  const lastWidthRef = useRef(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const iosLikeTouchWebKit = isIosLikeTouchWebKit();
    let raf = 0;

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

      // iOS Safari also changes visualViewport for bottom browser chrome.
      // Only treat large viewport compression as the soft keyboard; otherwise we add
      // padding that creates a visible dead zone above the Safari address bar.
      const layoutViewportHeight = window.innerHeight;
      const focusedTextInput = hasFocusedTextEditingSurface();
      const allowBottomOffsetBaseline = !iosLikeTouchWebKit || focusedTextInput;
      // During iPadOS keyboard presentation, Safari can transiently shrink innerHeight
      // together with visualViewport and restore it without another resize event. A
      // focused editing surface distinguishes that transition from browser chrome.
      const allowLayoutInsetBaseline = iosLikeTouchWebKit && focusedTextInput;
      const next: VisualViewportInsets = {
        bottomOffset: computeVisualViewportBottomOffset({
          layoutViewportHeight,
          visualViewportHeight: visualHeight,
          visualViewportOffsetTop: visualTop,
          baselineViewportHeight: baselineHeightRef.current,
          allowBaselineFallback: allowBottomOffsetBaseline,
        }),
        layoutBottomInset: computeVisualViewportLayoutBottomInset({
          layoutViewportHeight,
          visualViewportHeight: visualHeight,
          visualViewportOffsetTop: visualTop,
          baselineViewportHeight: baselineHeightRef.current,
          allowBaselineFallback: allowLayoutInsetBaseline,
        }),
      };
      setInsets((previous) =>
        previous.bottomOffset === next.bottomOffset &&
        previous.layoutBottomInset === next.layoutBottomInset
          ? previous
          : next,
      );
    };

    const scheduleUpdate = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    vv.addEventListener("resize", scheduleUpdate);
    vv.addEventListener("scroll", scheduleUpdate);

    // 键盘关闭后 visualViewport 更新可能滞后, 失焦延迟 300ms 再采样一次
    const onBlur = () => {
      setTimeout(scheduleUpdate, 300);
    };
    window.addEventListener("focusout", onBlur);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduleUpdate);
      vv.removeEventListener("resize", scheduleUpdate);
      vv.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("focusout", onBlur);
    };
  }, []);

  return insets;
}

function isIosLikeTouchWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent ?? "";
  const platform = navigator.platform ?? "";
  const maxTouchPoints = navigator.maxTouchPoints ?? 0;
  return (
    /iPad|iPhone|iPod/.test(userAgent) ||
    (platform === "MacIntel" &&
      maxTouchPoints > 1 &&
      (userAgent.includes("Mac OS X") || userAgent.includes("Macintosh")))
  );
}

function hasFocusedTextEditingSurface(): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLElement && activeElement.isContentEditable)
  );
}
