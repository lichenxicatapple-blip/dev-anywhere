// 虚拟列表 follow-output 状态, 用户滚到底部时自动追随; 滚离底部后冻结
import { useEffect, useRef, useState, type RefObject } from "react";

interface Options {
  threshold?: number;
}

export function useFollowOutput(
  scrollRef: RefObject<HTMLElement | null>,
  opts: Options = {},
): { isAtBottom: boolean; scrollToBottom: () => void } {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const thresholdRef = useRef(opts.threshold ?? 50);

  useEffect(() => {
    const el = scrollRef.current;
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
  }, [scrollRef]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  return { isAtBottom, scrollToBottom };
}
