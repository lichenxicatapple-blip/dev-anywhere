// 全局键盘快捷键注册 hook，支持 meta/ctrl 修饰，跨平台兼容 Mac Cmd 与 Win/Linux Ctrl
import { useEffect } from "react";

interface Options {
  meta?: boolean;
  ctrl?: boolean;
  preventDefault?: boolean;
}

export function useKeyboardShortcut(
  key: string,
  handler: (e: KeyboardEvent) => void,
  opts: Options = {},
): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const needsModifier = opts.meta || opts.ctrl;
      const modifierOk = needsModifier ? e.metaKey || e.ctrlKey : true;
      if (e.key.toLowerCase() === key.toLowerCase() && modifierOk) {
        if (opts.preventDefault) e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, handler, opts.meta, opts.ctrl, opts.preventDefault]);
}
