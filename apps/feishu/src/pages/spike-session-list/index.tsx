import { useState, useCallback, useRef } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import "./index.css";

interface Session {
  id: string;
  title: string;
  mode: "pty" | "json";
  state: "idle" | "working" | "waiting_approval" | "error" | "terminated";
  lastActive: string;
  swipeOpen?: boolean;
}

const MOCK_ACTIVE: Session[] = [
  { id: "1", title: "Analyze project structure", mode: "pty", state: "working", lastActive: "just now" },
  { id: "2", title: "Fix relay reconnection bug", mode: "json", state: "idle", lastActive: "3 min ago" },
  { id: "3", title: "New session", mode: "json", state: "waiting_approval", lastActive: "5 min ago" },
  { id: "4", title: "Deploy to production", mode: "json", state: "error", lastActive: "12 min ago" },
];

const MOCK_HISTORY: Session[] = [
  { id: "h1", title: "Setup monorepo structure", mode: "json", state: "terminated", lastActive: "yesterday" },
  { id: "h2", title: "Implement WebSocket relay", mode: "json", state: "terminated", lastActive: "2 days ago" },
];

function StateDot({ state }: { state: Session["state"] }) {
  return <View className={`state-dot ${state}`} />;
}

function ModeTag({ mode }: { mode: Session["mode"] }) {
  return (
    <View className={`mode-tag ${mode}`}>
      <Text className={`mode-tag-text ${mode}`}>{mode.toUpperCase()}</Text>
    </View>
  );
}

function SessionItem({
  session,
  isHistory,
  onSwipeToggle,
}: {
  session: Session;
  isHistory?: boolean;
  onSwipeToggle: (id: string) => void;
}) {
  const touchStart = useRef({ x: 0, y: 0 });

  const handleTouchStart = useCallback((e) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, []);

  const handleTouchEnd = useCallback((e) => {
    const dx = e.changedTouches[0].clientX - touchStart.current.x;
    const dy = e.changedTouches[0].clientY - touchStart.current.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) {
        onSwipeToggle(session.id);
      } else {
        onSwipeToggle("");
      }
    }
  }, [session.id, onSwipeToggle]);

  const handleTerminate = useCallback(() => {
    if (session.mode === "pty") {
      if (typeof tt !== "undefined") {
        tt.showToast({ title: "PTY session - terminate from computer", icon: "none" });
      }
    } else {
      if (typeof tt !== "undefined") {
        tt.showModal({ title: "End session?", content: "Claude process will be stopped." });
      }
    }
  }, [session.mode]);

  return (
    <View className="session-item-wrapper">
      <View
        className={`session-item ${session.swipeOpen ? "swiped" : ""}`}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <View className="session-info">
          <Text className="session-title" numberOfLines={1}>{session.title}</Text>
          <View className="session-meta-row">
            <StateDot state={session.state} />
            <Text className={`session-state-label ${session.state}`}>
              {session.state === "idle" ? "Idle" : session.state === "working" ? "Working" : session.state === "waiting_approval" ? "Approval" : session.state === "error" ? "Error" : "Ended"}
            </Text>
            <Text className="session-meta-sep">-</Text>
            <Text className="session-time">{session.lastActive}</Text>
          </View>
        </View>
        <ModeTag mode={session.mode} />
        <Text className="session-chevron">{">"}</Text>
      </View>
      <View className="swipe-action" onClick={handleTerminate}>
        <Text className="swipe-action-text">Terminate</Text>
      </View>
    </View>
  );
}

export default function SpikeSessionList() {
  const [sessions, setSessions] = useState(MOCK_ACTIVE);
  const [showEmpty, setShowEmpty] = useState(false);

  const handleSwipeToggle = useCallback((id: string) => {
    setSessions((prev) =>
      prev.map((s) => ({ ...s, swipeOpen: s.id === id ? !s.swipeOpen : false })),
    );
  }, []);

  return (
    <View className="page">
      <ScrollView className="list-scroll" scrollY>
        {showEmpty ? (
          <View className="empty-state">
            <Text className="empty-title">No Active Sessions</Text>
            <Text className="empty-body">Create a new session or connect from your computer</Text>
            <View className="empty-cta">
              <Text className="empty-cta-text">New Session</Text>
            </View>
          </View>
        ) : (
          <View>
            {/* Active sessions */}
            <Text className="section-header">Active Sessions</Text>
            {sessions.map((s) => (
              <SessionItem key={s.id} session={s} onSwipeToggle={handleSwipeToggle} />
            ))}

            {/* History sessions */}
            <Text className="section-header">History Sessions</Text>
            {MOCK_HISTORY.map((s) => (
              <SessionItem key={s.id} session={s} isHistory onSwipeToggle={handleSwipeToggle} />
            ))}
          </View>
        )}
      </ScrollView>

      {/* Toggle empty state (spike only) */}
      <View className="spike-toggle" onClick={() => setShowEmpty((v) => !v)}>
        <Text className="spike-toggle-text">{showEmpty ? "Show List" : "Show Empty"}</Text>
      </View>
    </View>
  );
}
