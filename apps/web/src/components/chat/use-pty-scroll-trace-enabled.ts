import { useEffect, useState } from "react";
import { isPtyScrollTraceEnabled } from "@/lib/pty-scroll-trace";

// 跟随 URL hash / popstate 事件刷新 isPtyScrollTraceEnabled，
// chat-pty-view 用来切换内嵌的 trace 复制按钮是否可见。
export function usePtyScrollTraceEnabled(): boolean {
  const [enabled, setEnabled] = useState(() => isPtyScrollTraceEnabled());

  useEffect(() => {
    const update = (): void => {
      setEnabled(isPtyScrollTraceEnabled());
    };
    update();
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  return enabled;
}
