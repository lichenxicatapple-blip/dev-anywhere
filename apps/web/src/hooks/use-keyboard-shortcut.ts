// 全局键盘快捷键注册 hook
// modifier: true 表示需要任一修饰键（metaKey || ctrlKey），跨平台兼容 Mac Cmd 与 Win/Linux Ctrl
// modifier 未设置或为 false 时，按 key 触发不需要修饰键
import { useEffect } from "react";

interface Options {
  modifier?: boolean;
  preventDefault?: boolean;
}

export function useKeyboardShortcut(
  key: string,
  handler: (e: KeyboardEvent) => void,
  opts: Options = {},
): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const modifierOk = opts.modifier ? e.metaKey || e.ctrlKey : true;
      if (e.key.toLowerCase() === key.toLowerCase() && modifierOk) {
        if (opts.preventDefault) e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, handler, opts.modifier, opts.preventDefault]);
}
