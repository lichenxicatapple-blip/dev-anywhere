// iOS Safari 键盘适配: 用 visualViewport 计算 InputBar 应平移多少以贴紧键盘上方
// 桌面或不支持 visualViewport 的浏览器降级为 0, 配合 env(safe-area-inset-bottom)
import { useEffect, useState } from "react";

export function useVisualViewportBottomOffset(): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const bottomOffset = window.innerHeight - vv.height - vv.offsetTop;
      setOffset(Math.max(bottomOffset, 0));
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    // 键盘关闭后 visualViewport 更新可能滞后, 失焦延迟 300ms 再采样一次
    const onBlur = () => {
      setTimeout(update, 300);
    };
    window.addEventListener("focusout", onBlur);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("focusout", onBlur);
    };
  }, []);

  return offset;
}
