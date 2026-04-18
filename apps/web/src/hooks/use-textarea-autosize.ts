// textarea 自撑高: 仅依赖 value 变化, 不监听 viewport resize (RESEARCH Pitfall 4)
import { useEffect, type RefObject } from "react";

interface Options {
  minHeight?: number;
  maxHeight?: number;
}

export function useTextareaAutosize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  opts: Options = {},
): void {
  const min = opts.minHeight ?? 48;
  const max = opts.maxHeight ?? 240;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const desired = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${desired}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [ref, value, min, max]);
}
