// 会话列表项：双行布局，状态圆点，模式标记，左滑终止
import { useCallback, useRef } from "react";
import { View, Text } from "@tarojs/components";
import type { CommonEventFunction } from "@tarojs/components";
import { showToast } from "@/components/toast";
import { showModal } from "@/components/modal";
import type { SessionInfo } from "@cc-anywhere/shared";
import { formatRelativeTime } from "@/utils/relative-time";
import { formatSessionName } from "@/utils/format-session-name";
import "./index.css";

interface TouchPoint { clientX: number; clientY: number }
interface TouchEventLike { touches: TouchPoint[]; changedTouches: TouchPoint[] }

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

  const handleTouchStart: CommonEventFunction = useCallback((e) => {
    const te = e as unknown as TouchEventLike;
    touchStart.current = { x: te.touches[0].clientX, y: te.touches[0].clientY };
  }, []);

  const handleTouchEnd: CommonEventFunction = useCallback(
    (e) => {
      const te = e as unknown as TouchEventLike;
      const dx = te.changedTouches[0].clientX - touchStart.current.x;
      const dy = te.changedTouches[0].clientY - touchStart.current.y;
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
      showToast("PTY session - terminate from computer");
    } else {
      void showModal({
        title: "End session?",
        content: "Claude process will be terminated.",
      }).then((res) => {
        if (res.confirm) {
          onTerminate();
        }
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
        <View className="sli-info">
          <Text className="sli-title" numberOfLines={1}>
            {formatSessionName(session.name)}
          </Text>
          <View className="sli-meta-row">
            <StateDot state={session.state} />
            <Text className={`sli-state-label sli-state-label-${session.state}`}>{stateLabel}</Text>
          </View>
        </View>
        {session.mode && <ModeTag mode={session.mode} />}
        <View className="sli-chevron" />
      </View>
      <View className="sli-action" onClick={handleTerminate}>
        <Text className="sli-action-text">Terminate</Text>
      </View>
    </View>
  );
}

// 历史会话列表项，显示标题、项目路径和相对时间
interface HistoryListItemProps {
  id: string;
  title: string;
  projectDir: string;
  updatedAt: number;
  onSelect: () => void;
}

export function HistoryListItem({ title, projectDir, updatedAt, onSelect }: HistoryListItemProps) {
  const shortDir = formatSessionName(projectDir);
  return (
    <View className="sli-wrapper">
      <View className="sli-item sli-history" onClick={onSelect}>
        <View className="sli-info">
          <Text className="sli-title" numberOfLines={1}>
            {title}
          </Text>
          <View className="sli-meta-row">
            <Text className="sli-subtitle">{shortDir}</Text>
            <Text className="sli-subtitle sli-time-sep">{formatRelativeTime(updatedAt)}</Text>
          </View>
        </View>
        <Text className="sli-resume-tag">Resume</Text>
      </View>
    </View>
  );
}
