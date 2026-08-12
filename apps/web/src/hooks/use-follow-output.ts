// 虚拟列表 follow-output 状态: 用户滚到底部时自动追随, 离底后冻结
import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  threshold?: number;
}

interface ScrollToBottomOptions {
  lockUntilUserInteraction?: boolean;
}

export function useFollowOutput(
  el: HTMLElement | null,
  opts: Options = {},
): {
  isAtBottom: boolean;
  scrollToBottom: (options?: ScrollToBottomOptions) => void;
  releaseFollowLock: () => void;
} {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const forceFollowRef = useRef(false);
  // 8px 吸收 subpixel rounding 与 virtualizer 重测量噪音, 任何更大回拉即出按钮
  const thresholdRef = useRef(opts.threshold ?? 8);

  useEffect(() => {
    if (!el) return;
    forceFollowRef.current = false;
    const setBottomState = (next: boolean) => {
      isAtBottomRef.current = next;
      setIsAtBottom(next);
    };
    const compute = () => {
      if (forceFollowRef.current) {
        el.scrollTop = el.scrollHeight;
        setBottomState(true);
        return;
      }
      const threshold = thresholdRef.current;
      setBottomState(el.scrollTop + el.clientHeight >= el.scrollHeight - threshold);
    };
    const preservePinnedBottom = () => {
      if (!forceFollowRef.current && !isAtBottomRef.current) {
        compute();
        return;
      }
      el.scrollTop = el.scrollHeight;
      setBottomState(true);
    };
    const releaseForcedFollow = () => {
      forceFollowRef.current = false;
    };
    compute();
    el.addEventListener("scroll", compute, { passive: true });
    el.addEventListener("pointerdown", releaseForcedFollow, { passive: true });
    el.addEventListener("touchstart", releaseForcedFollow, { passive: true });
    el.addEventListener("wheel", releaseForcedFollow, { passive: true });
    // scroll 事件不会在 scrollHeight 变化 (内容变多/变少) 时触发, virtualizer
    // estimate→measure 过渡里 inner sizer 会从 estimate*N 缩回 measured total,
    // 浏览器 clamp scrollTop 的那次不一定补发 scroll, isAtBottom 会卡在 false
    // 但容器变矮 (iOS 键盘弹起) 时, 如果用户本来就在底部, 几何计算会瞬间变成
    // "离底"; 这不是用户主动回拉, 应继续 pin 底部。
    const ro = new ResizeObserver(preservePinnedBottom);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
      preservePinnedBottom();
    });
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", compute);
      el.removeEventListener("pointerdown", releaseForcedFollow);
      el.removeEventListener("touchstart", releaseForcedFollow);
      el.removeEventListener("wheel", releaseForcedFollow);
      ro.disconnect();
      mo.disconnect();
    };
  }, [el]);

  const scrollToBottom = useCallback(
    (options: ScrollToBottomOptions = {}) => {
      forceFollowRef.current = options.lockUntilUserInteraction === true;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      isAtBottomRef.current = true;
      setIsAtBottom(true);
    },
    [el],
  );

  const releaseFollowLock = useCallback(() => {
    forceFollowRef.current = false;
  }, []);

  return { isAtBottom, scrollToBottom, releaseFollowLock };
}
