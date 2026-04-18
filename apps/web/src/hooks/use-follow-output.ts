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
  // 8px 吸收 subpixel rounding 与 virtualizer 重测量噪音, 任何更大回拉即出按钮
  const thresholdRef = useRef(opts.threshold ?? 8);

  useEffect(() => {
    if (!el) return;
    const compute = () => {
      const threshold = thresholdRef.current;
      setIsAtBottom(
        el.scrollTop + el.clientHeight >= el.scrollHeight - threshold,
      );
    };
    compute();
    el.addEventListener("scroll", compute, { passive: true });
    // scroll 事件不会在 scrollHeight 变化 (内容变多/变少) 时触发, virtualizer
    // estimate→measure 过渡里 inner sizer 会从 estimate*N 缩回 measured total,
    // 浏览器 clamp scrollTop 的那次不一定补发 scroll, isAtBottom 会卡在 false
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
      compute();
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
  };

  return { isAtBottom, scrollToBottom };
}
