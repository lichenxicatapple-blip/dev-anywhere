// 虚拟列表 follow-output 状态: 用户滚到底部时自动追随, 离底后冻结
import { useEffect, useRef, useState } from "react";

interface Options {
  threshold?: number;
}

export function useFollowOutput(
  el: HTMLElement | null,
  opts: Options = {},
): { isAtBottom: boolean; scrollToBottom: () => void } {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  // 8px 吸收 subpixel rounding 与 virtualizer 重测量噪音, 任何更大回拉即出按钮
  const thresholdRef = useRef(opts.threshold ?? 8);

  useEffect(() => {
    if (!el) return;
    const setBottomState = (next: boolean) => {
      isAtBottomRef.current = next;
      setIsAtBottom(next);
    };
    const compute = () => {
      const threshold = thresholdRef.current;
      setBottomState(el.scrollTop + el.clientHeight >= el.scrollHeight - threshold);
    };
    const preservePinnedBottom = () => {
      if (!isAtBottomRef.current) {
        compute();
        return;
      }
      el.scrollTop = el.scrollHeight;
      setBottomState(true);
    };
    compute();
    el.addEventListener("scroll", compute, { passive: true });
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
      ro.disconnect();
      mo.disconnect();
    };
  }, [el]);

  const scrollToBottom = () => {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  };

  return { isAtBottom, scrollToBottom };
}
