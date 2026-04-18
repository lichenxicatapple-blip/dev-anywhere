// 虚拟列表 follow-output 状态, 用户滚到底部时自动追随; 滚离底部后冻结
// 接收 HTMLElement (来自 state-backed callback ref), 避免 ref 对象稳定、
// useEffect 捕获 null 后永不重绑 listener 的问题
import { useEffect, useRef, useState } from "react";

interface Options {
  threshold?: number;
}

export function useFollowOutput(
  el: HTMLElement | null,
  opts: Options = {},
): { isAtBottom: boolean; scrollToBottom: () => void } {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const thresholdRef = useRef(opts.threshold ?? 50);

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
