// 历史会话区: 读 useSessionStore.historySessions, 点击行 → session_create + resumeSessionId
// 同一时刻只允许 1 个 resume 在飞 (session_create_response 无请求 id, 无法区分来源)
// 刷新按钮: 重新发 session_history_request, proxy 会重新扫 ~/.claude/projects/
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { History, RefreshCw } from "lucide-react";
import type { HistorySession, RelayControlMessage, SessionInfo } from "@cc-anywhere/shared";
import { useSessionStore } from "@/stores/session-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { showErrorToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { HistoryRow } from "./history-row";

interface HistoryListProps {
  now?: number;
}

export function HistoryList({ now }: HistoryListProps) {
  const historySessions = useSessionStore((s) => s.historySessions);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const navigate = useNavigate();

  // 只在 resume 在飞时挂订阅, 收到一次 response 就摘掉, 避免与 CreateSessionDialog 的同名订阅撞车
  useEffect(() => {
    if (!resumingId) return;
    const relay = relayClientRef;
    if (!relay) return;
    const unsub = relay.onMessage((msg) => {
      const ctrl = msg as RelayControlMessage;
      if (ctrl.type !== "session_create_response") return;
      unsub();
      setResumingId(null);
      if (ctrl.error || !ctrl.sessionId) {
        showErrorToast(`恢复失败: ${ctrl.error ?? "unknown"}`);
        return;
      }
      const newSession: SessionInfo = {
        sessionId: ctrl.sessionId,
        state: "idle",
        mode: "json",
      };
      useSessionStore.getState().addSession(newSession);
      navigate(`/chat/${ctrl.sessionId}?mode=json`);
    });
    return unsub;
  }, [resumingId, navigate]);

  function handleResume(h: HistorySession) {
    if (resumingId) return;
    const relay = relayClientRef;
    if (!relay) {
      showErrorToast("Relay 客户端未就绪");
      return;
    }
    setResumingId(h.id);
    relay.sendControl({
      type: "session_create",
      cwd: h.projectDir,
      resumeSessionId: h.id,
    });
  }

  function handleRefresh() {
    const relay = relayClientRef;
    if (!relay) return;
    relay.sendControl({ type: "session_history_request" });
  }

  if (historySessions.length === 0) return null;

  return (
    <div data-slot="history-list" className="flex flex-col">
      <div className="flex items-center gap-1.5 px-4 pt-3 pb-1">
        <History
          className="size-3.5 text-muted-foreground/70 shrink-0"
          aria-hidden="true"
        />
        <h3 className="text-sm font-semibold text-foreground">
          历史会话
          <span className="ml-1 text-muted-foreground/70 font-normal">
            · {historySessions.length}
          </span>
        </h3>
        <button
          type="button"
          onClick={handleRefresh}
          aria-label="刷新历史会话"
          data-slot="history-refresh"
          className={cn(
            "ml-auto size-6 rounded-md flex items-center justify-center",
            "text-muted-foreground hover:text-foreground hover:bg-accent",
            "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <ul role="list" className="flex flex-col">
        {historySessions.map((h) => (
          <HistoryRow
            key={`${h.projectDir}::${h.id}`}
            session={h}
            now={now}
            disabled={resumingId !== null}
            loading={resumingId === h.id}
            onClick={() => handleResume(h)}
          />
        ))}
      </ul>
    </div>
  );
}
