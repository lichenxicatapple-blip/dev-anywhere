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
    const onScroll = () => {
      const threshold = thresholdRef.current;
      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
      setIsAtBottom(atBottom);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [el]);

  const scrollToBottom = () => {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  return { isAtBottom, scrollToBottom };
}
