// PTY 终端栅格渲染组件，支持双向滚动和捏合缩放
import { useRef, useCallback, useEffect } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import type { CommonEventFunction } from "@tarojs/components";
import type { TermLine } from "@cc-anywhere/shared";
import "./index.css";

// Taro View/ScrollView 的 onTouch* 声明为 CommonEventFunction，但运行时事件包含 touch 字段
interface TouchPoint { clientX: number; clientY: number }
interface TouchEventLike { touches: TouchPoint[]; changedTouches: TouchPoint[] }

interface TerminalViewportProps {
  lines: TermLine[];
  fontSize: number;
  onPinchZoom: (direction: "in" | "out") => void;
}

function getDistance(touches: { clientX: number; clientY: number }[]): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function TerminalViewport({ lines, fontSize, onPinchZoom }: TerminalViewportProps) {
  const pinchRef = useRef({ startDistance: 0, triggered: false });
  const scrollRef = useRef("");
  const prevLinesLenRef = useRef(0);

  // 新行到达时自动滚动到底部
  useEffect(() => {
    if (lines.length > prevLinesLenRef.current && lines.length > 0) {
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

  return (
    <ScrollView
      className="terminal-viewport"
      scrollX
      scrollY
      scrollIntoView={scrollRef.current}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
    >
      <View className="terminal-content">
        {lines.map((line, i) => (
          <View
            key={i}
            id={`term-line-${i}`}
            className="terminal-line"
            style={{
              fontSize: `${fontSize}PX`,
              lineHeight: `${Math.round(fontSize * 1.4)}PX`,
              minHeight: `${Math.round(fontSize * 1.4)}PX`,
            }}
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
