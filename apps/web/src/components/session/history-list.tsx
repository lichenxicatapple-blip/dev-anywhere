// 历史会话区: 读 useSessionStore.historySessions, 按 projectDir 分组, 默认全折叠
// group header 自带 chevron + 短路径 + 计数, 点击展开才看到 HistoryRow
// 点击行 → session_create + resumeSessionId; 同一时刻只允许 1 个 resume 在飞
// (session_create_response 无请求 id, 无法区分来源, 所以简单锁死)
// 刷新按钮: 重新发 session_history_request, proxy 会重新扫 ~/.claude/projects/
// group 顺序沿用 historySessions 的 updatedAt 降序 (proxy 保证), 最近活跃的 project 在最上
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronRight, History, RefreshCw } from "lucide-react";
import type { HistorySession, RelayControlMessage, SessionInfo } from "@cc-anywhere/shared";
import { useSessionStore } from "@/stores/session-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { showErrorToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { formatSessionName } from "@/lib/format-session-name";
import { HistoryRow } from "./history-row";

interface HistoryListProps {
  now?: number;
}

export function HistoryList({ now }: HistoryListProps) {
  const historySessions = useSessionStore((s) => s.historySessions);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const groups = useMemo(() => {
    const map = new Map<string, HistorySession[]>();
    for (const h of historySessions) {
      const list = map.get(h.projectDir);
      if (list) list.push(h);
      else map.set(h.projectDir, [h]);
    }
    return Array.from(map.entries()).map(([dir, sessions]) => ({
      dir,
      shortDir: formatSessionName(dir),
      sessions,
    }));
  }, [historySessions]);

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

  function toggleGroup(dir: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
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
        {groups.map((g) => {
          const expanded = expandedGroups.has(g.dir);
          return (
            <li key={g.dir}>
              <button
                type="button"
                onClick={() => toggleGroup(g.dir)}
                aria-expanded={expanded}
                data-slot="history-group-header"
                data-expanded={expanded}
                className={cn(
                  "w-full flex items-center gap-1.5 px-4 py-2 min-h-[36px]",
                  "text-left transition-colors outline-none",
                  "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground/80 transition-transform",
                    expanded && "rotate-90",
                  )}
                  aria-hidden="true"
                />
                <span
                  className="text-sm font-mono truncate flex-1 min-w-0"
                  title={g.dir}
                >
                  {g.shortDir}
                </span>
                <span className="text-xs text-muted-foreground/80 tabular-nums shrink-0">
                  {g.sessions.length}
                </span>
              </button>
              {expanded && (
                <ul role="list" className="flex flex-col">
                  {g.sessions.map((h) => (
                    <HistoryRow
                      key={h.id}
                      session={h}
                      now={now}
                      disabled={resumingId !== null}
                      loading={resumingId === h.id}
                      onClick={() => handleResume(h)}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
