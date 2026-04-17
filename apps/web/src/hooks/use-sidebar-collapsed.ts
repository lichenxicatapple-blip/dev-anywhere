// 侧栏折叠状态 hook，localStorage key = cc_sidebarCollapsed，值 "1"|"0"
// SSR-safe：初始化时检查 window 是否存在
import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "cc_sidebarCollapsed";

export function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "1";
  });

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // 同步其他 tab 的 storage 变化，保持多 tab 行为一致
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setCollapsed(e.newValue === "1");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { collapsed, toggle };
}
