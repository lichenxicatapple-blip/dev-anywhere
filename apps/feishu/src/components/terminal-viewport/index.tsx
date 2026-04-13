// PTY 终端栅格渲染组件，支持服务端滚动和捏合缩放
// server-side scrolling: content 只有一帧，用 DOM touch/mouse 事件检测滑动方向
// Taro H5 的 onTouchStart/Move prop 不触发，必须直接 addEventListener
import { useRef, useEffect } from "react";
import { View, Text } from "@tarojs/components";
import type { TermLine } from "@cc-anywhere/shared";
import "./index.css";

interface TerminalViewportProps {
  lines: TermLine[];
  fontSize: number;
  onPinchZoom: (direction: "in" | "out") => void;
  onScroll: (direction: "up" | "down", delta: number) => void;
}

// 每 20px 滑动距离算 1 行
const PX_PER_LINE = 20;
// 最小滑动距离才触发滚动请求
const MIN_SWIPE_PX = 30;
// 节流间隔
const THROTTLE_MS = 150;

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
}: TerminalViewportProps) {
  // 用 ref 保存最新回调，避免 useEffect 频繁重绑
  const onScrollRef = useRef(onScroll);
  const onPinchZoomRef = useRef(onPinchZoom);
  onScrollRef.current = onScroll;
  onPinchZoomRef.current = onPinchZoom;

  // 直接绑定 DOM 事件，同时支持 touch 和 mouse
  useEffect(() => {
    const el = document.querySelector(".terminal-viewport") as HTMLElement | null;
    if (!el) return;

    let startY = 0;
    let isDown = false;
    let lastRequestTime = 0;
    // 捏合缩放状态
    let pinchStartDist = 0;
    let pinchTriggered = false;

    // 返回 true 表示发出了滚动请求，调用者应重置 startY
    function handleSwipe(dy: number): boolean {
      if (Math.abs(dy) < MIN_SWIPE_PX) return false;
      const now = Date.now();
      if (now - lastRequestTime < THROTTLE_MS) return false;
      lastRequestTime = now;

      const delta = Math.max(1, Math.round(Math.abs(dy) / PX_PER_LINE));
      if (dy > 0) {
        onScrollRef.current("up", delta);
      } else {
        onScrollRef.current("down", delta);
      }
      return true;
    }

    // --- Touch events ---
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
        // 只在实际发出请求后才重置起始点，否则累积距离
        if (handleSwipe(dy)) {
          startY = e.touches[0].clientY;
        }
      }
    }

    // --- Mouse events (桌面浏览器调试用) ---
    function onMouseDown(e: MouseEvent) {
      startY = e.clientY;
      isDown = true;
    }

    function onMouseMove(e: MouseEvent) {
      if (!isDown) return;
      const dy = startY - e.clientY;
      if (handleSwipe(dy)) {
        startY = e.clientY;
      }
    }

    function onMouseUp() {
      isDown = false;
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

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
    </View>
  );
}
