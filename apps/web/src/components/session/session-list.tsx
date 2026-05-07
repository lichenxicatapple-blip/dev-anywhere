// SessionList dual-layout 组件：page 全屏列表，sidebar 嵌入桌面侧栏。
// layout=page: 移动端全屏列表 + 底部浮动 "+ 新建会话" 按钮
// layout=sidebar: 桌面侧栏中段；"+ 新建会话" 由 Sidebar 底部 slot 通过 CreateSessionButton 单独承载
//
// Sidebar imports both SessionList and CreateSessionButton from this module; keep those exports stable.
//
// 历史会话区 (HistoryList) 渲染在活跃列表下方, 即使无活跃会话但有历史时也可见,
// 只要历史非空就提供 "继续上次对话" 的入口, 空态仅在 active=0 && history=0 时出现
import { useEffect, useState } from "react";
import { useNavigate, useMatch } from "react-router";
import { ChevronRight, Plus, Loader2 } from "lucide-react";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shell/empty-state";
import { cn } from "@/lib/utils";
import type { AgentStatusPayload, PtyStatePayload, SessionInfo } from "@dev-anywhere/shared";
import { compareProvider, providerLabel, type SessionProvider } from "@/lib/session-provider";
import { SessionRow } from "./session-row";
import { HistoryList } from "./history-list";
import { CreateSessionDialog } from "./create-session-dialog";
import { SessionTerminationDialog } from "./session-termination-dialog";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";
import {
  applyDisplayStateToSession,
  resolveSessionDisplayState,
} from "@/lib/session-display-state";

interface SessionListProps {
  layout: "page" | "sidebar";
}

export function SessionList({ layout }: SessionListProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const ptyStateBySessionId = useSessionStore((s) => s.ptyStateBySessionId);
  const agentStatusBySessionId = useSessionStore((s) => s.agentStatusBySessionId);
  const sessionListLoaded = useSessionStore((s) => s.sessionListLoaded);
  // 选中态绑 URL: /chat/:id 命中当前行才高亮, 离开 chat 页 (/sessions, /) 自动全部无高亮
  const chatMatch = useMatch("/chat/:id");
  const activeSessionId = chatMatch?.params.id ?? null;
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const proxyListLoaded = useAppStore((s) => s.proxyListLoaded);
  // 冷启动刷新时, proxy_list / session_list envelope 均未到, 显示 spinner 避免 no-proxy / no-session 一闪而过
  const isLoading = !proxyListLoaded || (hasProxy && !sessionListLoaded);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingTermination, setPendingTermination] = useState<SessionInfo | null>(null);
  const [collapsedActiveProviders, setCollapsedActiveProviders] = useState<Set<SessionProvider>>(
    new Set(),
  );
  // 每分钟推一次 now，让 SessionRow 里的 "N 分钟前" 跟着走；store 不动也能滚
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  function handleRowClick(sessionId: string, mode: "pty" | "json" | undefined) {
    const resolvedMode = mode ?? "json";
    // URL 更新但不触发页面级 transition；AppShell 是父路由，Outlet 内直接切换。
    navigate(`/chat/${sessionId}?mode=${resolvedMode}`, { replace: false });
  }

  function handleTerminate(session: SessionInfo) {
    const sessionId = session.sessionId;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("Relay 客户端未就绪");
      return;
    }
    relay.sendControl({ type: "session_terminate", sessionId });
    useSessionStore.getState().removeSession(sessionId);
    if (sessionId === activeSessionId) navigate("/sessions");
    toast.info(
      session?.mode === "pty" && session.ptyOwner === "local-terminal"
        ? "已断开远程连接，本地终端仍在运行"
        : "已发送终止请求",
    );
  }

  function toggleActiveProvider(provider: SessionProvider) {
    setCollapsedActiveProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }

  const sessionsWithPtyState = sessions.map((session) =>
    applyLiveStateToSession(
      session,
      ptyStateBySessionId[session.sessionId],
      agentStatusBySessionId[session.sessionId],
    ),
  );
  const hasActive = sessionsWithPtyState.length > 0;

  // 加载中 / 无 proxy: 两个 layout 分别走各自的空态; 其他情况统一渲染 active + history 两个 section,
  // 各自内部做 "暂无..." 提示, 而不是 short-circuit 出一个大 EmptyState
  if (layout === "sidebar" && (isLoading || !hasProxy)) {
    return (
      <>
        <div className="px-4 py-3 text-sm text-muted-foreground/70">
          {isLoading ? "连接中..." : "请先选择 Proxy"}
        </div>
        <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
        <SessionTerminationDialog
          open={pendingTermination !== null}
          session={pendingTermination}
          onOpenChange={(open) => {
            if (!open) setPendingTermination(null);
          }}
          onConfirm={handleTerminate}
        />
      </>
    );
  }
  if (layout === "page" && isLoading) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground animate-in fade-in-0 duration-200 motion-reduce:animate-none">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <p className="text-sm">连接中...</p>
      </div>
    );
  }
  if (layout === "page" && !hasProxy) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1">
          <EmptyState variant="no-proxy" />
        </div>
        <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
        <SessionTerminationDialog
          open={pendingTermination !== null}
          session={pendingTermination}
          onOpenChange={(open) => {
            if (!open) setPendingTermination(null);
          }}
          onConfirm={handleTerminate}
        />
      </div>
    );
  }

  // page 布局里 sidebar 外层没有 "活跃会话" 标签, 所以在这里补一个 inline header
  const pageActiveHeader =
    layout === "page" ? (
      <h3 className="px-4 pt-3 pb-2 text-sm font-semibold text-foreground">
        活跃会话
        {hasActive ? (
          <span className="ml-1 text-muted-foreground/70 font-normal">
            · {sessionsWithPtyState.length}
          </span>
        ) : null}
      </h3>
    ) : null;

  const activeListElement = hasActive ? (
    <ul role="list" className="flex flex-col w-full min-w-0">
      {groupActiveSessionsByProvider(sessionsWithPtyState).map((group) => (
        <li key={group.provider}>
          <button
            type="button"
            onClick={() => toggleActiveProvider(group.provider)}
            aria-expanded={!collapsedActiveProviders.has(group.provider)}
            className={cn(
              "flex w-full items-center gap-2 px-4 pt-2 pb-1 min-h-[32px]",
              "text-xs text-muted-foreground",
              "text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <span className="font-mono">{providerLabel(group.provider)}</span>
            <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
            <span className="tabular-nums">{group.sessions.length}</span>
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/80 transition-transform",
                !collapsedActiveProviders.has(group.provider) && "rotate-90",
              )}
              aria-hidden="true"
            />
          </button>
          {!collapsedActiveProviders.has(group.provider) ? (
            <ul role="list" className="flex flex-col">
              {group.sessions.map((s) => (
                <SessionRow
                  key={s.sessionId}
                  session={s}
                  selected={s.sessionId === activeSessionId}
                  now={now}
                  onClick={() => handleRowClick(s.sessionId, s.mode)}
                  onTerminate={() => setPendingTermination(s)}
                />
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  ) : (
    <div className="px-4 py-3 text-sm text-muted-foreground/70" data-slot="active-empty">
      暂无活跃会话
    </div>
  );

  // HistoryList 自己处理空态 (header + "暂无全部会话" 提示), 这里无条件渲染
  const historyElement = <HistoryList now={now} />;

  if (layout === "page") {
    return (
      <div className="flex flex-col h-full">
        {/* 用原生 overflow-y-auto 而不是 radix ScrollArea: 后者内部 `display:table` wrapper */}
        {/* 会把 history 行按内容宽度撑到 800+px, 使 `truncate` 完全失效 */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {pageActiveHeader}
          {activeListElement}
          {historyElement}
        </div>
        <div className="px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] border-t border-border">
          <Button className="w-full" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" />
            新建会话
          </Button>
        </div>
        <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
        <SessionTerminationDialog
          open={pendingTermination !== null}
          session={pendingTermination}
          onOpenChange={(open) => {
            if (!open) setPendingTermination(null);
          }}
          onConfirm={handleTerminate}
        />
      </div>
    );
  }

  // layout === "sidebar": 列表占据 Sidebar 中段；底部 CTA 由 CreateSessionButton 承载
  // "活跃会话" section 标签由 sidebar.tsx 外层提供, 这里只渲染行列表 / 空态 + HistoryList
  // 直接用 overflow-y-auto 而非 ScrollArea，避免 radix ScrollArea 内部 table-wrapper 打破 truncate 链路
  return (
    <>
      <div className="h-full overflow-y-auto">
        {activeListElement}
        {historyElement}
      </div>
      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
      <SessionTerminationDialog
        open={pendingTermination !== null}
        session={pendingTermination}
        onOpenChange={(open) => {
          if (!open) setPendingTermination(null);
        }}
        onConfirm={handleTerminate}
      />
    </>
  );
}

function groupActiveSessionsByProvider(sessions: SessionInfo[]) {
  const map = new Map<SessionProvider, SessionInfo[]>();
  for (const session of sessions) {
    const list = map.get(session.provider);
    if (list) list.push(session);
    else map.set(session.provider, [session]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => compareProvider(a, b))
    .map(([provider, groupedSessions]) => ({ provider, sessions: groupedSessions }));
}

function applyLiveStateToSession(
  session: SessionInfo,
  ptyState: PtyStatePayload | undefined,
  agentStatus: AgentStatusPayload | undefined,
): SessionInfo {
  return applyDisplayStateToSession(
    session,
    resolveSessionDisplayState({
      session,
      ptyState,
      agentStatus,
      hasPendingApproval: false,
    }),
  );
}

// 侧栏底部的 "+ 新建会话" 按钮触发器 —— 被 10-01b sidebar.tsx 直接 import
// 未绑定 proxy 时: 视觉置灰 (aria-disabled + 手动 class), 但点击触发 Tooltip 解释原因
export function CreateSessionButton() {
  const [open, setOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);

  function handleClick() {
    if (!hasProxy) {
      setTipOpen(true);
      window.setTimeout(() => setTipOpen(false), 2000);
      return;
    }
    setOpen(true);
  }

  const button = (
    <Button
      variant="outline"
      className={cn(
        "w-full justify-start gap-2 h-10 border-border",
        !hasProxy && "opacity-50 hover:bg-background",
      )}
      aria-disabled={!hasProxy}
      onClick={handleClick}
    >
      <Plus aria-hidden="true" />
      新建会话
    </Button>
  );

  return (
    <>
      {hasProxy ? (
        button
      ) : (
        <Tooltip open={tipOpen} onOpenChange={setTipOpen}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top">请先选择 Proxy</TooltipContent>
        </Tooltip>
      )}
      <CreateSessionDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
