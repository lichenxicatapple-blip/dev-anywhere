// 历史会话区: 读 useSessionStore.historySessions, 按 projectDir 分组, 双层折叠
// 外层: section 整体默认折叠, 点 "历史会话" header 整体展开; 活跃会话优先占主视野
// 内层: 展开后每个 projectDir group 默认再折叠, 点 chevron 才看到 HistoryRow
// 点击行 → session_create + resumeSessionId; 同一时刻只允许 1 个 resume 在飞
// (session_create_response 无请求 id, 无法区分来源, 所以简单锁死)
// 刷新按钮: 重新发 session_history_request, proxy 会重新扫 ~/.claude/projects/
// group 顺序沿用 historySessions 的 updatedAt 降序 (proxy 保证), 最近活跃的 project 在最上
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { HistorySession, RelayControlMessage, SessionInfo } from "@cc-anywhere/shared";
import { useSessionStore } from "@/stores/session-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { formatSessionName } from "@/lib/format-session-name";
import { HistoryRow } from "./history-row";

interface HistoryListProps {
  now?: number;
}

export function HistoryList({ now }: HistoryListProps) {
  const historySessions = useSessionStore((s) => s.historySessions);
  const [resumingId, setResumingId] = useState<string | null>(null);
  // 整个历史会话区默认折叠, 让活跃会话占据主视野; 点 header 整体展开后再点 group chevron 看行
  const [sectionExpanded, setSectionExpanded] = useState(false);
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
        toast.error(`恢复失败: ${ctrl.error ?? "unknown"}`);
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
      toast.error("Relay 客户端未就绪");
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

  const hasHistory = historySessions.length > 0;

  return (
    <div data-slot="history-list" className="flex flex-col">
      {/* section header 整行做 toggle 触发器; 刷新按钮放里边要 stopPropagation, 否则点刷新也会 toggle */}
      {/* 历史为空时 header 的 toggle/chevron 都禁用, 只保留刷新 (可能扫完 claude 目录后就出来了) */}
      <button
        type="button"
        onClick={() => hasHistory && setSectionExpanded((v) => !v)}
        disabled={!hasHistory}
        aria-expanded={hasHistory ? sectionExpanded : undefined}
        data-slot="history-section-header"
        data-expanded={sectionExpanded}
        className={cn(
          "w-full flex items-center gap-1.5 px-4 py-2 min-h-[36px]",
          "text-left transition-colors outline-none",
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:hover:bg-transparent disabled:cursor-default",
        )}
      >
        <h3 className="text-sm font-semibold text-foreground">
          全部会话
          {hasHistory ? (
            <span className="ml-1 text-muted-foreground/70 font-normal">
              · {historySessions.length}
            </span>
          ) : null}
        </h3>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            handleRefresh();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              handleRefresh();
            }
          }}
          aria-label="刷新全部会话"
          data-slot="history-refresh"
          className={cn(
            "ml-auto size-6 rounded-md flex items-center justify-center",
            "text-muted-foreground hover:text-foreground hover:bg-accent",
            "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </span>
        {hasHistory ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/80 transition-transform",
              sectionExpanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {!hasHistory && (
        <div className="px-4 py-3 text-sm text-muted-foreground/70" data-slot="history-empty">
          暂无会话记录
        </div>
      )}
      {hasHistory && sectionExpanded && (
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
                    "w-full flex items-center gap-1.5 pl-6 pr-4 py-2 min-h-[36px]",
                    "text-left transition-colors outline-none",
                    "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <span className="text-sm font-mono truncate flex-1 min-w-0" title={g.dir}>
                    {g.shortDir}
                  </span>
                  <span className="text-xs text-muted-foreground/80 tabular-nums shrink-0">
                    {g.sessions.length}
                  </span>
                  <ChevronRight
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground/80 transition-transform",
                      expanded && "rotate-90",
                    )}
                    aria-hidden="true"
                  />
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
      )}
    </div>
  );
}
