// 历史会话区: 读 useSessionStore.historySessions, 按 projectDir 分组, 双层折叠
// 外层: section 整体默认折叠, 点 "历史会话" header 整体展开; 活跃会话优先占主视野
// 内层: 展开后每个 projectDir group 默认再折叠, 点 chevron 才看到 HistoryRow
// 点击行 → session_create + resumeSessionId; 同一时刻只允许 1 个 resume 在飞。
// 刷新按钮: 通过 RelayClient 请求历史会话, proxy 会重新扫 ~/.claude/projects/
// group 顺序沿用 historySessions 的 updatedAt 降序 (proxy 保证), 最近活跃的 project 在最上
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { HistorySession, SessionInfo } from "@dev-anywhere/shared";
import { useSessionStore } from "@/stores/session-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { formatSessionName } from "@/lib/format-session-name";
import {
  compareProvider,
  historySessionProvider,
  providerLabel,
  type SessionProvider,
} from "@/lib/session-provider";
import { HistoryRow } from "./history-row";

interface HistoryListProps {
  now?: number;
}

type RestoreMode = "pty" | "json";

export function HistoryList({ now }: HistoryListProps) {
  const historySessions = useSessionStore((s) => s.historySessions);
  const [resumingId, setResumingId] = useState<string | null>(null);
  // 整个历史会话区默认折叠, 让活跃会话占据主视野; 点 header 整体展开后再点 group chevron 看行
  const [sectionExpanded, setSectionExpanded] = useState(false);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<SessionProvider>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const providerGroups = useMemo(() => {
    const providerMap = new Map<SessionProvider, Map<string, HistorySession[]>>();
    for (const h of historySessions) {
      const provider = historySessionProvider(h);
      let projectMap = providerMap.get(provider);
      if (!projectMap) {
        projectMap = new Map<string, HistorySession[]>();
        providerMap.set(provider, projectMap);
      }
      const list = projectMap.get(h.projectDir);
      if (list) list.push(h);
      else projectMap.set(h.projectDir, [h]);
    }
    return Array.from(providerMap.entries())
      .sort(([a], [b]) => compareProvider(a, b))
      .map(([provider, projectMap]) => ({
        provider,
        sessions: Array.from(projectMap.values()).flat(),
        projects: Array.from(projectMap.entries()).map(([dir, sessions]) => ({
          dir,
          shortDir: formatSessionName(dir),
          sessions,
        })),
      }));
  }, [historySessions]);

  async function handleResume(h: HistorySession, mode: RestoreMode) {
    if (resumingId) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    setResumingId(h.id);
    const provider = historySessionProvider(h);
    try {
      const ctrl = await relay.createSession({
        cwd: h.projectDir,
        mode,
        provider,
        resumeSessionId: h.id,
      });
      if (ctrl.error || !ctrl.sessionId) {
        toast.error(`恢复失败：${ctrl.error ?? "未知错误"}`);
        return;
      }
      const newSession: SessionInfo = {
        sessionId: ctrl.sessionId,
        state: "idle",
        mode: ctrl.mode ?? mode,
        provider: ctrl.provider ?? "claude",
      };
      useSessionStore.getState().addSession(newSession);
      navigate(`/chat/${ctrl.sessionId}?mode=${ctrl.mode ?? mode}`);
    } catch (err) {
      toast.error(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResumingId(null);
    }
  }

  function handleRefresh() {
    const relay = relayClientRef;
    if (!relay) return;
    void relay
      .requestSessionHistory()
      .then((sessions) => useSessionStore.getState().setHistorySessions(sessions))
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      });
  }

  function toggleGroup(provider: SessionProvider, dir: string) {
    const key = historyProjectGroupKey(provider, dir);
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleProvider(provider: SessionProvider) {
    setCollapsedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
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
          {providerGroups.map((providerGroup) => {
            const providerCollapsed = collapsedProviders.has(providerGroup.provider);
            return (
              <li key={providerGroup.provider}>
                <button
                  type="button"
                  onClick={() => toggleProvider(providerGroup.provider)}
                  aria-expanded={!providerCollapsed}
                  data-slot="history-provider-header"
                  data-expanded={!providerCollapsed}
                  className={cn(
                    "w-full flex items-center gap-2 px-4 pt-2 pb-1 min-h-[32px]",
                    "text-xs text-muted-foreground text-left transition-colors outline-none",
                    "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <span className="font-mono">{providerLabel(providerGroup.provider)}</span>
                  <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
                  <span className="tabular-nums">{providerGroup.sessions.length}</span>
                  <ChevronRight
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground/80 transition-transform",
                      !providerCollapsed && "rotate-90",
                    )}
                    aria-hidden="true"
                  />
                </button>
                {!providerCollapsed && (
                  <ul role="list" className="flex flex-col">
                    {providerGroup.projects.map((g) => {
                      const groupKey = historyProjectGroupKey(providerGroup.provider, g.dir);
                      const expanded = expandedGroups.has(groupKey);
                      return (
                        <li key={groupKey}>
                          <button
                            type="button"
                            onClick={() => toggleGroup(providerGroup.provider, g.dir)}
                            aria-expanded={expanded}
                            data-slot="history-group-header"
                            data-expanded={expanded}
                            className={cn(
                              "w-full flex items-center gap-1.5 pl-6 pr-4 py-2 min-h-[36px]",
                              "text-left transition-colors outline-none",
                              "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                          >
                            <span
                              className="text-sm font-mono truncate flex-1 min-w-0"
                              title={g.dir}
                            >
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
                                  onClick={() => {
                                    const mode = directRestoreMode(h);
                                    if (mode) void handleResume(h, mode);
                                  }}
                                  restoreModes={explicitRestoreModes(h)}
                                  onRestoreMode={(mode) => handleResume(h, mode)}
                                />
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
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

function historyProjectGroupKey(provider: SessionProvider, dir: string): string {
  return `${provider}:${dir}`;
}

function directRestoreMode(session: HistorySession): RestoreMode | null {
  if (session.preferredMode) return session.preferredMode;
  const provider = historySessionProvider(session);
  return provider === "codex" ? "pty" : null;
}

function explicitRestoreModes(session: HistorySession): RestoreMode[] | undefined {
  if (directRestoreMode(session)) return undefined;
  const provider = historySessionProvider(session);
  return provider === "claude" ? ["json", "pty"] : undefined;
}
