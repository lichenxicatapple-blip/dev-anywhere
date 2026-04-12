// PTY 终端栅格渲染组件，支持服务端滚动和捏合缩放
import { useRef, useCallback, useEffect } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import type { CommonEventFunction } from "@tarojs/components";
import type { TermLine } from "@cc-anywhere/shared";
import "./index.css";

// Taro View/ScrollView 的 onTouch* 声明为 CommonEventFunction，但运行时事件包含 touch 字段
interface TouchPoint { clientX: number; clientY: number }
interface TouchEventLike { touches: TouchPoint[]; changedTouches: TouchPoint[] }

// Taro ScrollView onScroll 事件 detail 结构
interface ScrollDetail { scrollTop: number; scrollHeight: number }
interface ScrollEventLike { detail: ScrollDetail }

interface TerminalViewportProps {
  lines: TermLine[];
  fontSize: number;
  onPinchZoom: (direction: "in" | "out") => void;
  onScroll: (direction: "up" | "down", delta: number) => void;
}

function getDistance(touches: { clientX: number; clientY: number }[]): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function TerminalViewport({
  lines,
  fontSize,
  onPinchZoom,
  onScroll,
}: TerminalViewportProps) {
  const pinchRef = useRef({ startDistance: 0, triggered: false });
  const scrollRef = useRef("");
  const prevLinesLenRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const viewportHeightRef = useRef(0);
  const lastScrollRequestRef = useRef(0);

  // 新帧到达时，仅在用户未手动滚动时自动滚动到底部
  useEffect(() => {
    if (lines.length > 0 && !userScrolledUpRef.current) {
      scrollRef.current = `term-line-${lines.length - 1}`;
    }
    prevLinesLenRef.current = lines.length;
  }, [lines.length]);

  const handleTouchStart: CommonEventFunction = useCallback((e) => {
    const te = e as unknown as TouchEventLike;
    if (te.touches.length === 2) {
      const touches = te.touches.map((t) => ({ clientX: t.clientX, clientY: t.clientY }));
      pinchRef.current.startDistance = getDistance(touches);
      pinchRef.current.triggered = false;
    }
  }, []);

  const handleTouchMove: CommonEventFunction = useCallback(
    (e) => {
      const te = e as unknown as TouchEventLike;
      if (te.touches.length === 2 && !pinchRef.current.triggered) {
        const touches = te.touches.map((t) => ({ clientX: t.clientX, clientY: t.clientY }));
        const currentDistance = getDistance(touches);
        const ratio = currentDistance / pinchRef.current.startDistance;
        if (ratio > 1.3) {
          pinchRef.current.triggered = true;
          onPinchZoom("in");
        } else if (ratio < 0.7) {
          pinchRef.current.triggered = true;
          onPinchZoom("out");
        }
      }
    },
    [onPinchZoom],
  );

  // 滚动事件处理：检测顶部/底部并发送服务端滚动请求，带 200ms 节流
  const handleScrollEvent = useCallback(
    (scrollTop: number, scrollHeight: number) => {
      const clientHeight = viewportHeightRef.current;
      const nearBottom = clientHeight > 0 && scrollTop + clientHeight >= scrollHeight - 50;
      const nearTop = scrollTop < 50;

      const now = Date.now();
      const throttled = now - lastScrollRequestRef.current < 200;

      if (nearTop && !throttled) {
        userScrolledUpRef.current = true;
        lastScrollRequestRef.current = now;
        onScroll("up", 10);
      } else if (nearBottom && userScrolledUpRef.current && !throttled) {
        userScrolledUpRef.current = false;
        lastScrollRequestRef.current = now;
        onScroll("down", 10);
      }
    },
    [onScroll],
  );

  const handleScroll: CommonEventFunction = useCallback(
    (e) => {
      const se = e as unknown as ScrollEventLike;
      handleScrollEvent(se.detail.scrollTop, se.detail.scrollHeight);
    },
    [handleScrollEvent],
  );

  // H5 环境下通过 DOM 获取 viewport 高度，并绑定原生 scroll 事件
  // Taro ScrollView 的 onScroll prop 在 H5 Web Component 下不触发，
  // 必须直接 addEventListener 绕过。小程序环境 onScroll prop 正常工作，不需要此逻辑。
  useEffect(() => {
    if (process.env.TARO_ENV !== "h5") return;
    const el = document.querySelector(".terminal-viewport");
    if (!el) return;

    viewportHeightRef.current = el.clientHeight;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        viewportHeightRef.current = entry.contentRect.height;
      }
    });
    observer.observe(el);

    const nativeScrollHandler = () => {
      handleScrollEvent(el.scrollTop, el.scrollHeight);
    };
    el.addEventListener("scroll", nativeScrollHandler);

    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", nativeScrollHandler);
    };
  }, [handleScrollEvent]);

  const lineStyle = (fs: number) => ({
    fontSize: `${fs}PX`,
    lineHeight: `${Math.round(fs * 1.4)}PX`,
    minHeight: `${Math.round(fs * 1.4)}PX`,
  });

  return (
    <ScrollView
      className="terminal-viewport"
      scrollX
      scrollY
      scrollIntoView={scrollRef.current}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onScroll={handleScroll}
    >
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
    </ScrollView>
  );
}
