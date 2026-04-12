// PTY 终端栅格渲染组件，支持双向滚动、捏合缩放和 scrollback 历史加载
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
  scrollbackLines: TermLine[];
  fontSize: number;
  onPinchZoom: (direction: "in" | "out") => void;
  onScrollToTop: () => void;
  onScrollPositionChange: (nearBottom: boolean) => void;
  isLoadingScrollback: boolean;
  isAtOldest: boolean;
}

function getDistance(touches: { clientX: number; clientY: number }[]): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function TerminalViewport({
  lines,
  scrollbackLines,
  fontSize,
  onPinchZoom,
  onScrollToTop,
  onScrollPositionChange,
  isLoadingScrollback,
  isAtOldest,
}: TerminalViewportProps) {
  const pinchRef = useRef({ startDistance: 0, triggered: false });
  const scrollRef = useRef("");
  const prevLinesLenRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const viewportHeightRef = useRef(0);

  // 新行到达时，仅在用户未浏览 scrollback 时自动滚动到底部
  useEffect(() => {
    const totalLen = scrollbackLines.length + lines.length;
    if (lines.length > prevLinesLenRef.current && lines.length > 0 && !userScrolledUpRef.current) {
      scrollRef.current = `term-line-${totalLen - 1}`;
    }
    prevLinesLenRef.current = lines.length;
  }, [lines.length, scrollbackLines.length]);

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

  const handleScroll: CommonEventFunction = useCallback(
    (e) => {
      const se = e as unknown as ScrollEventLike;
      const { scrollTop, scrollHeight } = se.detail;
      const clientHeight = viewportHeightRef.current;

      const nearBottom = clientHeight > 0 && scrollTop + clientHeight >= scrollHeight - 50;
      const nearTop = scrollTop < 100;

      userScrolledUpRef.current = !nearBottom;
      onScrollPositionChange(nearBottom);

      if (nearTop && !isLoadingScrollback && !isAtOldest) {
        onScrollToTop();
      }
    },
    [onScrollToTop, onScrollPositionChange, isLoadingScrollback, isAtOldest],
  );

  // H5 环境下通过 DOM 获取 viewport 高度，并绑定原生 scroll 事件
  // Taro ScrollView 的 onScroll prop 在 H5 Web Component 下不触发，
  // 必须直接 addEventListener 绕过
  useEffect(() => {
    if (typeof document === "undefined") return;
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
      const scrollTop = el.scrollTop;
      const scrollHeight = el.scrollHeight;
      const clientHeight = viewportHeightRef.current;

      const nearBottom = clientHeight > 0 && scrollTop + clientHeight >= scrollHeight - 50;
      const nearTop = scrollTop < 100;

      userScrolledUpRef.current = !nearBottom;
      onScrollPositionChange(nearBottom);

      if (nearTop && !isLoadingScrollback && !isAtOldest) {
        onScrollToTop();
      }
    };
    el.addEventListener("scroll", nativeScrollHandler);

    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", nativeScrollHandler);
    };
  }, [onScrollToTop, onScrollPositionChange, isLoadingScrollback, isAtOldest]);

  const allLines = [...scrollbackLines, ...lines];
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
        {isLoadingScrollback && (
          <View className="scrollback-loading">
            <Text>Loading history...</Text>
          </View>
        )}
        {!isLoadingScrollback && isAtOldest && scrollbackLines.length > 0 && (
          <View className="scrollback-oldest">
            <Text>Beginning of session</Text>
          </View>
        )}
        {allLines.map((line, i) => (
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
