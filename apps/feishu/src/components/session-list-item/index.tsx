// 会话列表项：双行布局，状态圆点，模式标记，左滑终止
import { useCallback, useRef } from "react";
import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import type { SessionInfo } from "@cc-anywhere/shared";
import { formatRelativeTime } from "@/utils/relative-time";
import "./index.css";

interface SessionListItemProps {
  session: SessionInfo;
  onSelect: () => void;
  onTerminate: () => void;
  swipeOpen: boolean;
  onSwipeToggle: (id: string) => void;
}

function StateDot({ state }: { state: SessionInfo["state"] }) {
  return <View className={`sli-state-dot sli-state-${state}`} />;
}

function ModeTag({ mode }: { mode: "pty" | "json" }) {
  return (
    <View className={`sli-mode-tag sli-mode-${mode}`}>
      <Text className={`sli-mode-text sli-mode-text-${mode}`}>{mode.toUpperCase()}</Text>
    </View>
  );
}

export function SessionListItem({
  session,
  onSelect,
  onTerminate,
  swipeOpen,
  onSwipeToggle,
}: SessionListItemProps) {
  const touchStart = useRef({ x: 0, y: 0 });

  const handleTouchStart = useCallback((e: { touches: Array<{ clientX: number; clientY: number }> }) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, []);

  const handleTouchEnd = useCallback(
    (e: { changedTouches: Array<{ clientX: number; clientY: number }> }) => {
      const dx = e.changedTouches[0].clientX - touchStart.current.x;
      const dy = e.changedTouches[0].clientY - touchStart.current.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) {
          onSwipeToggle(session.sessionId);
        } else {
          onSwipeToggle("");
        }
      }
    },
    [session.sessionId, onSwipeToggle],
  );

  const handleTerminate = useCallback(() => {
    if (session.mode === "pty") {
      Taro.showToast({ title: "PTY session - terminate from computer", icon: "none" });
    } else {
      Taro.showModal({
        title: "End session?",
        content: "Claude process will be terminated.",
        success: (res) => {
          if (res.confirm) {
            onTerminate();
          }
        },
      });
    }
  }, [session.mode, onTerminate]);

  // SessionInfo 没有 updatedAt 字段，显示状态文本
  const stateLabel =
    session.state === "idle"
      ? "Idle"
      : session.state === "working"
        ? "Working"
        : session.state === "waiting_approval"
          ? "Approval"
          : session.state === "error"
            ? "Error"
            : "Ended";

  return (
    <View className="sli-wrapper">
      <View
        className={`sli-item ${swipeOpen ? "sli-swiped" : ""}`}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onClick={swipeOpen ? undefined : onSelect}
      >
        <StateDot state={session.state} />
        <View className="sli-info">
          <View className="sli-title-row">
            <Text className="sli-title" numberOfLines={1}>
              {session.name || "New Session"}
            </Text>
            {session.mode && <ModeTag mode={session.mode} />}
          </View>
          <Text className="sli-subtitle">{stateLabel}</Text>
        </View>
        <Text className="sli-chevron">{">"}</Text>
      </View>
      <View className="sli-action" onClick={handleTerminate}>
        <Text className="sli-action-text">Terminate</Text>
      </View>
    </View>
  );
}

// 历史会话列表项，简化版本
interface HistoryListItemProps {
  id: string;
  title: string;
  updatedAt: number;
  onSelect: () => void;
}

export function HistoryListItem({ title, updatedAt, onSelect }: HistoryListItemProps) {
  return (
    <View className="sli-wrapper">
      <View className="sli-item" onClick={onSelect}>
        <View className="sli-state-dot sli-state-terminated" />
        <View className="sli-info">
          <Text className="sli-title" numberOfLines={1}>
            {title}
          </Text>
          <Text className="sli-subtitle">{formatRelativeTime(updatedAt)}</Text>
        </View>
        <Text className="sli-resume-tag">Resume</Text>
        <Text className="sli-chevron">{">"}</Text>
      </View>
    </View>
  );
}
