import type { Terminal } from "@xterm/xterm";

interface PtyScrollDomAdapterOptions {
  container: HTMLDivElement;
  term: Terminal;
  onWheel: (event: WheelEvent) => void;
  onTouchStart: (event: TouchEvent) => void;
  onTouchMove: (event: TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
  onContainerScroll: () => void;
  onTermScroll: () => void;
  onRender: () => void;
  onRelayout: () => void;
  onWriteParsed?: () => void;
}

interface PtyScrollDomAdapter {
  dispose: () => void;
}

export function attachPtyScrollDomAdapter({
  container,
  term,
  onWheel,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onTouchCancel,
  onContainerScroll,
  onTermScroll,
  onRender,
  onRelayout,
  onWriteParsed,
}: PtyScrollDomAdapterOptions): PtyScrollDomAdapter {
  container.addEventListener("wheel", onWheel, { passive: false, capture: true });
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: true });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchCancel, { passive: true });
  container.addEventListener("scroll", onContainerScroll, { passive: true });

  const dispScroll = term.onScroll(onTermScroll);
  const dispRender = term.onRender(onRender);
  const dispWriteParsed = onWriteParsed ? term.onWriteParsed?.(onWriteParsed) : undefined;

  // host 自身尺寸由 controller 主动写；只 observe container，避免写入 host 后反馈 relayout。
  const ro = new ResizeObserver(onRelayout);
  ro.observe(container);

  return {
    dispose: () => {
      container.removeEventListener("scroll", onContainerScroll);
      container.removeEventListener("wheel", onWheel, { capture: true });
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchCancel);
      dispScroll.dispose();
      dispRender.dispose();
      dispWriteParsed?.dispose();
      ro.disconnect();
    },
  };
}
