// iOS Safari 键盘适配: 用 visualViewport 计算 InputBar 应平移多少以贴紧键盘上方
// 桌面或不支持 visualViewport 的浏览器降级为 0, 配合 env(safe-area-inset-bottom)
import { useEffect, useRef, useState } from "react";

const VISUAL_VIEWPORT_HEIGHT_VAR = "--dev-visual-viewport-height";
const SOFT_KEYBOARD_MIN_OCCLUDED_VIEWPORT_SHARE = 0.3;
const TOUCH_TABLET_MIN_SHORT_EDGE = 600;
const TOUCH_TABLET_MIN_LONG_EDGE = 768;

interface VisualViewportBottomOffsetInput {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop: number;
  baselineViewportHeight: number;
  allowBaselineFallback?: boolean;
}

export type VisualViewportOcclusionKind = "none" | "soft-keyboard" | "accessory-or-browser-ui";

export interface VisualViewportInsets {
  occlusionKind: VisualViewportOcclusionKind;
  bottomOffset: number;
  layoutBottomInset: number;
  rawBottomOffset: number;
  rawLayoutBottomInset: number;
  occlusionReason: string;
}

interface TouchTabletViewportInput {
  width: number;
  height: number;
  maxTouchPoints: number;
}

export function isTouchTabletViewport({
  width,
  height,
  maxTouchPoints,
}: TouchTabletViewportInput): boolean {
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  return (
    maxTouchPoints > 0 &&
    shortEdge >= TOUCH_TABLET_MIN_SHORT_EDGE &&
    longEdge >= TOUCH_TABLET_MIN_LONG_EDGE
  );
}

export function computeVisualViewportBottomOffset({
  ...input
}: VisualViewportBottomOffsetInput): number {
  return classifyVisualViewportOcclusion(input).bottomOffset;
}

export function classifyVisualViewportOcclusion({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
  baselineViewportHeight,
  allowBaselineFallback = true,
}: VisualViewportBottomOffsetInput): VisualViewportInsets {
  const currentBottomInset = layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop;
  const baselineBottomInset =
    baselineViewportHeight - visualViewportHeight - visualViewportOffsetTop;

  const currentCandidate = classifyOcclusionCandidate({
    bottomInset: currentBottomInset,
    visualViewportHeight,
    referenceViewportHeight: layoutViewportHeight,
    source: "current",
  });
  const baselineCandidate = allowBaselineFallback
    ? classifyOcclusionCandidate({
        bottomInset: baselineBottomInset,
        visualViewportHeight,
        referenceViewportHeight: baselineViewportHeight,
        source: "baseline",
      })
    : { kind: "none" as const, bottomInset: 0, reason: "baseline-disabled" };

  const bottomOffset = Math.max(
    currentCandidate.kind === "soft-keyboard" ? currentCandidate.bottomInset : 0,
    baselineCandidate.kind === "soft-keyboard" ? baselineCandidate.bottomInset : 0,
  );
  const layoutBottomInset =
    currentCandidate.kind === "soft-keyboard" ? Math.max(currentBottomInset, 0) : 0;
  const rawBottomOffset = Math.max(
    currentBottomInset,
    allowBaselineFallback ? baselineBottomInset : 0,
    0,
  );
  const rawLayoutBottomInset = Math.max(currentBottomInset, 0);

  if (bottomOffset > 0) {
    return {
      occlusionKind: "soft-keyboard",
      bottomOffset,
      layoutBottomInset,
      rawBottomOffset,
      rawLayoutBottomInset,
      occlusionReason:
        currentCandidate.kind === "soft-keyboard"
          ? currentCandidate.reason
          : baselineCandidate.reason,
    };
  }

  if (rawBottomOffset > 0 || rawLayoutBottomInset > 0) {
    return {
      occlusionKind: "accessory-or-browser-ui",
      bottomOffset: 0,
      layoutBottomInset: 0,
      rawBottomOffset,
      rawLayoutBottomInset,
      occlusionReason:
        currentCandidate.kind !== "none" ? currentCandidate.reason : baselineCandidate.reason,
    };
  }

  return {
    occlusionKind: "none",
    bottomOffset: 0,
    layoutBottomInset: 0,
    rawBottomOffset: 0,
    rawLayoutBottomInset: 0,
    occlusionReason: "none",
  };
}

export function computeVisualViewportLayoutBottomInset({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
}: Omit<VisualViewportBottomOffsetInput, "baselineViewportHeight">): number {
  return classifyVisualViewportOcclusion({
    layoutViewportHeight,
    visualViewportHeight,
    visualViewportOffsetTop,
    baselineViewportHeight: layoutViewportHeight,
    allowBaselineFallback: false,
  }).layoutBottomInset;
}

function classifyOcclusionCandidate({
  bottomInset,
  visualViewportHeight,
  referenceViewportHeight,
  source,
}: {
  bottomInset: number;
  visualViewportHeight: number;
  referenceViewportHeight: number;
  source: "current" | "baseline";
}):
  | { kind: "none"; bottomInset: 0; reason: string }
  | { kind: "soft-keyboard" | "accessory-or-browser-ui"; bottomInset: number; reason: string } {
  const inset = Math.max(bottomInset, 0);
  if (inset <= 0) return { kind: "none", bottomInset: 0, reason: `${source}:none` };

  const occludedShare = inset / Math.max(referenceViewportHeight, 1);
  const visibleShare = visualViewportHeight / Math.max(referenceViewportHeight, 1);
  // Treat only substantial lower-screen occlusion as a soft keyboard. Smaller
  // visualViewport deltas are still exposed as raw telemetry, but they must not
  // move the PTY layout because iPad browser chrome, IME palettes, and autofill
  // accessory bars all report as viewport changes too.
  const keyboardSizedOcclusion = occludedShare >= SOFT_KEYBOARD_MIN_OCCLUDED_VIEWPORT_SHARE;

  return {
    kind: keyboardSizedOcclusion ? "soft-keyboard" : "accessory-or-browser-ui",
    bottomInset: inset,
    reason: `${source}:visible=${visibleShare.toFixed(2)} occluded=${occludedShare.toFixed(2)}`,
  };
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
    occlusionKind: "none",
    bottomOffset: 0,
    layoutBottomInset: 0,
    rawBottomOffset: 0,
    rawLayoutBottomInset: 0,
    occlusionReason: "none",
  });
  const baselineHeightRef = useRef(0);
  const lastWidthRef = useRef(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const allowBaselineFallback = !isIosLikeTouchWebKit();

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
      const next = classifyVisualViewportOcclusion({
        layoutViewportHeight,
        visualViewportHeight: visualHeight,
        visualViewportOffsetTop: visualTop,
        baselineViewportHeight: baselineHeightRef.current,
        allowBaselineFallback,
      });
      setInsets((previous) =>
        previous.occlusionKind === next.occlusionKind &&
        previous.bottomOffset === next.bottomOffset &&
        previous.layoutBottomInset === next.layoutBottomInset &&
        previous.rawBottomOffset === next.rawBottomOffset &&
        previous.rawLayoutBottomInset === next.rawLayoutBottomInset &&
        previous.occlusionReason === next.occlusionReason
          ? previous
          : next,
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
