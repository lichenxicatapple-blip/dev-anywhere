// PTY 终端栅格渲染组件，支持服务端滚动和捏合缩放
// native scroll 处理 within-frame 内容溢出（server 终端行数可能超过手机 viewport）
// 到达滚动边界（顶部/底部）时触发 server-side scroll 请求获取历史内容
// Taro H5 的 onScroll/onTouch props 不触发，必须直接 addEventListener
import { useRef, useEffect } from "react";
import { View, Text } from "@tarojs/components";
import type { TermLine } from "@/types/terminal-legacy";
import { BackToBottomButton } from "@/components/back-to-bottom";
import "./index.css";

interface TerminalViewportProps {
  lines: TermLine[];
  fontSize: number;
  onPinchZoom: (direction: "in" | "out") => void;
  onScroll: (direction: "up" | "down", delta: number) => void;
  isScrolled?: boolean;
  onTapToReturn?: () => void;
}

const PX_PER_LINE = 20;
const MIN_SWIPE_PX = 20;
const THROTTLE_MS = 100;

function getDistance(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function TerminalViewport({
  lines,
  fontSize,
  onPinchZoom,
  onScroll,
  isScrolled,
  onTapToReturn,
}: TerminalViewportProps) {
  const onScrollRef = useRef(onScroll);
  const onPinchZoomRef = useRef(onPinchZoom);
  onScrollRef.current = onScroll;
  onPinchZoomRef.current = onPinchZoom;


  useEffect(() => {
    const el = document.querySelector(".terminal-viewport") as HTMLElement | null;
    if (!el) return;

    let startY = 0;
    let isDown = false;
    let lastRequestTime = 0;
    let pinchStartDist = 0;
    let pinchTriggered = false;

    function handleSwipe(dy: number): boolean {
      if (Math.abs(dy) < MIN_SWIPE_PX) return false;
      const now = Date.now();
      if (now - lastRequestTime < THROTTLE_MS) return false;
      lastRequestTime = now;
      const delta = Math.max(1, Math.round(Math.abs(dy) / PX_PER_LINE));
      onScrollRef.current(dy > 0 ? "up" : "down", delta);
      return true;
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        pinchStartDist = getDistance(e.touches[0], e.touches[1]);
        pinchTriggered = false;
      } else if (e.touches.length === 1) {
        startY = e.touches[0].clientY;
      }
    }

    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      if (e.touches.length === 2 && !pinchTriggered) {
        const dist = getDistance(e.touches[0], e.touches[1]);
        const ratio = dist / pinchStartDist;
        if (ratio > 1.3) { pinchTriggered = true; onPinchZoomRef.current("in"); }
        else if (ratio < 0.7) { pinchTriggered = true; onPinchZoomRef.current("out"); }
        return;
      }
      if (e.touches.length === 1) {
        const dy = startY - e.touches[0].clientY;
        if (handleSwipe(dy)) startY = e.touches[0].clientY;
      }
    }

    function onMouseDown(e: MouseEvent) {
      startY = e.clientY;
      isDown = true;
    }

    function onMouseMove(e: MouseEvent) {
      if (!isDown) return;
      const dy = startY - e.clientY;
      if (handleSwipe(dy)) startY = e.clientY;
    }

    function onMouseUp() {
      isDown = false;
    }

    // wheel 事件：触摸板双指垂直滑动
    let wheelAccum = 0;
    function onWheel(e: WheelEvent) {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      wheelAccum += e.deltaY;
      if (Math.abs(wheelAccum) < MIN_SWIPE_PX) return;
      const now = Date.now();
      if (now - lastRequestTime < THROTTLE_MS) {
        wheelAccum = 0;
        return;
      }
      lastRequestTime = now;
      const clamped = Math.min(Math.abs(wheelAccum), 200);
      const delta = Math.max(1, Math.round(clamped / PX_PER_LINE));
      const direction = wheelAccum > 0 ? "up" : "down";
      onScrollRef.current(direction, delta);
      wheelAccum = 0;
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("mouseup", onMouseUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("wheel", onWheel);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // viewport 高度对齐：扣除 padding 后缩小到 lineHeight 整数倍，消除顶部行裁剪
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(".terminal-viewport") as HTMLElement | null;
      const contentEl = document.querySelector(".terminal-content") as HTMLElement | null;
      if (!el || !contentEl) return;
      el.style.maxHeight = "";
      void el.offsetHeight;
      const h = el.getBoundingClientRect().height;
      const lineH = Math.round(fontSize * 1.4);
      if (lineH <= 0) return;
      const style = getComputedStyle(contentEl);
      const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const usable = h - pad;
      const remainder = usable % lineH;
      if (remainder > 0.5) {
        el.style.maxHeight = `${h - remainder}px`;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [fontSize]);

  const lineStyle = (fs: number) => ({
    fontSize: `${fs}PX`,
    lineHeight: `${Math.round(fs * 1.4)}PX`,
    minHeight: `${Math.round(fs * 1.4)}PX`,
  });

  return (
    <View className="terminal-viewport">
      <View className="terminal-content">
        {lines.map((line, i) => (
          <View
            key={i}
            id={`term-line-${i}`}
            className="terminal-line"
            style={lineStyle(fontSize)}
          >
            {line.map((span, j) => (
              <Text
                key={j}
                selectable
                style={{
                  color: span.fg || "#D4D4D4",
                  backgroundColor: span.bg || "transparent",
                  fontWeight: span.bold ? "bold" : "normal",
                }}
              >
                {span.text || " "}
              </Text>
            ))}
          </View>
        ))}
      </View>
      <BackToBottomButton visible={!!isScrolled} onClick={onTapToReturn ?? (() => {})} />
    </View>
  );
}
