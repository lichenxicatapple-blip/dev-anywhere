// SessionList dual-layout 组件：page 全屏列表，sidebar 嵌入桌面侧栏。
// layout=page: 移动端全屏列表 + 底部浮动 "+ 新建会话" 按钮
// layout=sidebar: 桌面侧栏中段；"+ 新建会话" 由 Sidebar 底部 slot 通过 CreateSessionButton 单独承载
//
// Sidebar imports both SessionList and CreateSessionButton from this module; keep those exports stable.
//
// 历史会话区 (HistoryList) 渲染在活跃列表下方, 即使无活跃会话但有历史时也可见,
// 只要历史非空就提供 "继续上次对话" 的入口, 空态仅在 active=0 && history=0 时出现
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useNavigate, useMatch } from "react-router";
import { Bot, ChevronRight, Loader2, PlusCircle, Terminal } from "lucide-react";
import { useSessionStore } from "@/stores/session-store";
import { useChatStore } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/shell/empty-state";
import { cn } from "@/lib/utils";
import type { SessionInfo } from "@dev-anywhere/shared";
import { compareProvider, providerLabel, type SessionProvider } from "@/lib/session-provider";
import { SessionRow } from "./session-row";
import { HistoryList } from "./history-list";
import { CreateSessionDialog } from "./create-session-dialog";
import { submitTerminalCreate } from "./create-session-submit";
import { SessionRenameDialog } from "./session-rename-dialog";
import { SessionTerminationDialog } from "./session-termination-dialog";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";
import { resolveSessionRowState } from "@/lib/session-row-state";

interface SessionListProps {
  layout: "page" | "sidebar";
}

type ActiveSessionGroupKey = SessionProvider | "terminal";

export function SessionList({ layout }: SessionListProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const sessionListLoaded = useSessionStore((s) => s.sessionListLoaded);
  const agentStatusBySessionId = useSessionStore((s) => s.agentStatusBySessionId);
  const ptyStateBySessionId = useSessionStore((s) => s.ptyStateBySessionId);
  const renameSession = useSessionStore((s) => s.renameSession);
  const chatBySessionId = useChatStore((s) => s.bySessionId);
  // 选中态绑 URL: /chat/:id 命中当前行才高亮, 离开 chat 页 (/sessions, /) 自动全部无高亮
  const chatMatch = useMatch("/chat/:id");
  const activeSessionId = chatMatch?.params.id ?? null;
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const proxyListLoaded = useAppStore((s) => s.proxyListLoaded);
  // 冷启动刷新时, proxy_list / session_list envelope 均未到, 显示 spinner 避免 no-proxy / no-session 一闪而过
  const isLoading = !proxyListLoaded || (hasProxy && !sessionListLoaded);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [createTypeOpen, setCreateTypeOpen] = useState(false);
  const [pendingRename, setPendingRename] = useState<SessionInfo | null>(null);
  const [pendingTermination, setPendingTermination] = useState<SessionInfo | null>(null);
  const { creatingTerminal, createTerminal } = useTerminalCreator();
  const [collapsedActiveProviders, setCollapsedActiveProviders] = useState<
    Set<ActiveSessionGroupKey>
  >(new Set());
  // 每分钟推一次 now，让活跃/历史会话里的相对时间跟着走；store 不动也能滚
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
      toast.error("请先连接开发机");
      return;
    }
    relay.sendControl({ type: "session_terminate", sessionId });
    useSessionStore.getState().removeSession(sessionId);
    if (sessionId === activeSessionId) navigate("/sessions");
    if (session?.mode === "pty" && session.ptyOwner === "local-terminal") {
      // local-terminal "页面断开" 是行为说明, 给用户读完整句的时间
      toast.info("已断开页面连接，本地终端仍在运行");
    } else {
      // 其它路径已经做了 optimistic 移除, sidebar 立刻更新, toast 只是动作回执;
      // 默认 4s 太长, 缩到 1.5s 即扫即过
      toast.info("正在终止会话", { duration: 1500 });
    }
  }

  async function handleRename(sessionId: string, name: string): Promise<void> {
    const relay = relayClientRef;
    if (!relay) {
      throw new Error("请先连接开发机");
    }
    const result = await relay.renameSession(sessionId, name);
    if (!result.success) {
      throw new Error(result.error ?? "重命名失败");
    }
    renameSession(sessionId, result.name ?? name);
    toast.success("已重命名会话");
  }

  function toggleActiveProvider(provider: ActiveSessionGroupKey) {
    setCollapsedActiveProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }

  function withDisplayState(session: SessionInfo): SessionInfo {
    const hasPendingApproval =
      session.mode === "json" &&
      (chatBySessionId[session.sessionId]?.pendingApprovals.some((a) => a.status === "pending") ??
        false);
    const displayState = resolveSessionRowState({
      session,
      agentStatus: agentStatusBySessionId[session.sessionId],
      ptyState: ptyStateBySessionId[session.sessionId],
      hasPendingApproval,
    });
    return displayState === session.state ? session : { ...session, state: displayState };
  }

  const hasActive = sessions.length > 0;

  // 加载中 / 无 proxy: 两个 layout 分别走各自的空态; 其他情况统一渲染 active + history 两个 section,
  // 各自内部做 "暂无..." 提示, 而不是 short-circuit 出一个大 EmptyState
  if (layout === "sidebar" && (isLoading || !hasProxy)) {
    return (
      <>
        <div className="px-4 py-3 text-sm text-muted-foreground/70">
          {isLoading ? "连接中..." : "请先连接开发机"}
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
        <SessionRenameDialog
          open={pendingRename !== null}
          sessionId={pendingRename?.sessionId ?? null}
          initialName={pendingRename?.name}
          onOpenChange={(open) => {
            if (!open) setPendingRename(null);
          }}
          onRename={handleRename}
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
        <SessionRenameDialog
          open={pendingRename !== null}
          sessionId={pendingRename?.sessionId ?? null}
          initialName={pendingRename?.name}
          onOpenChange={(open) => {
            if (!open) setPendingRename(null);
          }}
          onRename={handleRename}
        />
      </div>
    );
  }

  const activeHeader = (
    <h3
      className="px-4 pt-3 pb-2 text-sm font-semibold text-foreground"
      data-slot="active-section-header"
    >
      活跃会话
      {hasActive ? (
        <span className="ml-1 text-muted-foreground/70 font-normal">· {sessions.length}</span>
      ) : null}
    </h3>
  );

  const activeListElement = hasActive ? (
    <ul role="list" className="flex flex-col w-full min-w-0">
      {groupActiveSessionsByProvider(sessions).map((group) => (
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
            <span className="font-mono">{sessionGroupLabel(group.provider)}</span>
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
                  session={withDisplayState(s)}
                  selected={s.sessionId === activeSessionId}
                  now={now}
                  onClick={() => handleRowClick(s.sessionId, s.mode)}
                  onRename={() => setPendingRename(s)}
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
          {activeHeader}
          {activeListElement}
          {historyElement}
        </div>
        <div className="px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] border-t border-border">
          <Button
            className="min-h-11 w-full md:min-h-0"
            data-slot="create-session-mobile-trigger"
            onClick={() => setCreateTypeOpen(true)}
          >
            <PlusCircle aria-hidden="true" />
            新建
          </Button>
        </div>
        <CreateSessionTypeSheet
          open={createTypeOpen}
          creatingTerminal={creatingTerminal}
          onOpenChange={setCreateTypeOpen}
          onCreateAgent={() => {
            setCreateTypeOpen(false);
            setCreateOpen(true);
          }}
          onCreateTerminal={() => void createTerminal(() => setCreateTypeOpen(false))}
        />
        <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
        <SessionTerminationDialog
          open={pendingTermination !== null}
          session={pendingTermination}
          onOpenChange={(open) => {
            if (!open) setPendingTermination(null);
          }}
          onConfirm={handleTerminate}
        />
        <SessionRenameDialog
          open={pendingRename !== null}
          sessionId={pendingRename?.sessionId ?? null}
          initialName={pendingRename?.name}
          onOpenChange={(open) => {
            if (!open) setPendingRename(null);
          }}
          onRename={handleRename}
        />
      </div>
    );
  }

  // layout === "sidebar": 列表占据 Sidebar 中段；底部 CTA 由 CreateSessionButton 承载
  // "活跃会话" section 标签必须和行列表 / HistoryList 同属一个滚动容器, 否则滚动历史时标题会误导当前分区。
  // 直接用 overflow-y-auto 而非 ScrollArea，避免 radix ScrollArea 内部 table-wrapper 打破 truncate 链路
  return (
    <>
      <div className="dev-sidebar-scroll h-full overflow-y-auto overscroll-contain">
        {activeHeader}
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
      <SessionRenameDialog
        open={pendingRename !== null}
        sessionId={pendingRename?.sessionId ?? null}
        initialName={pendingRename?.name}
        onOpenChange={(open) => {
          if (!open) setPendingRename(null);
        }}
        onRename={handleRename}
      />
    </>
  );
}

function groupActiveSessionsByProvider(sessions: SessionInfo[]) {
  const map = new Map<ActiveSessionGroupKey, SessionInfo[]>();
  for (const session of sessions) {
    const key: ActiveSessionGroupKey = session.kind === "terminal" ? "terminal" : session.provider;
    const list = map.get(key);
    if (list) list.push(session);
    else map.set(key, [session]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => compareSessionGroup(a, b))
    .map(([provider, groupedSessions]) => ({ provider, sessions: groupedSessions }));
}

function sessionGroupLabel(provider: ActiveSessionGroupKey): string {
  return provider === "terminal" ? "终端" : providerLabel(provider);
}

function compareSessionGroup(a: ActiveSessionGroupKey, b: ActiveSessionGroupKey) {
  if (a === b) return 0;
  if (a === "terminal") return -1;
  if (b === "terminal") return 1;
  return compareProvider(a, b);
}

function useTerminalCreator() {
  const navigate = useNavigate();
  const [creatingTerminal, setCreatingTerminal] = useState(false);

  async function createTerminal(onCreated?: () => void): Promise<void> {
    if (creatingTerminal) return;
    setCreatingTerminal(true);
    try {
      const result = await submitTerminalCreate({ relay: relayClientRef });
      if (result.type !== "success") {
        toast.error(result.message);
        return;
      }
      useSessionStore.getState().addSession(result.session);
      onCreated?.();
      navigate(result.route);
    } finally {
      setCreatingTerminal(false);
    }
  }

  return { creatingTerminal, createTerminal };
}

// 未绑定 proxy 时: 视觉置灰 (aria-disabled + 手动 class), 但点击触发 Tooltip 解释原因
export function CreateSessionButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const suppressMenuRestoreFocusRef = useRef(false);
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const { creatingTerminal, createTerminal } = useTerminalCreator();

  function showMissingProxyTip() {
    setTipOpen(true);
    window.setTimeout(() => setTipOpen(false), 2000);
  }

  function handleCreateAgent() {
    if (!hasProxy) {
      showMissingProxyTip();
      return;
    }
    suppressMenuRestoreFocusRef.current = true;
    setOpen(true);
  }

  function handleCreateTerminal() {
    if (!hasProxy) {
      showMissingProxyTip();
      return;
    }
    suppressMenuRestoreFocusRef.current = true;
    void createTerminal();
  }

  function handleBlockedTrigger(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    showMissingProxyTip();
  }

  const triggerButton = (
    <Button
      variant="outline"
      data-slot="create-session-trigger"
      className={cn(
        compact
          ? "h-11 w-11 justify-center border-border px-0"
          : "h-[46px] w-full justify-center gap-2 border-border px-3",
        !hasProxy && "opacity-50 hover:bg-background",
      )}
      aria-label="新建会话"
      aria-disabled={!hasProxy}
      onClick={!hasProxy ? handleBlockedTrigger : undefined}
    >
      <PlusCircle className="size-4 text-muted-foreground" aria-hidden="true" />
      {!compact && <span className="truncate">新建</span>}
    </Button>
  );

  const menuButton = hasProxy ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={compact ? "end" : "start"}
        className="w-52"
        data-slot="create-session-type-menu"
        onCloseAutoFocus={(event) => {
          if (!suppressMenuRestoreFocusRef.current) return;
          suppressMenuRestoreFocusRef.current = false;
          event.preventDefault();
        }}
      >
        <DropdownMenuItem
          className="min-h-9 gap-2.5"
          data-slot="create-agent-session-item"
          onSelect={handleCreateAgent}
        >
          <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
          Agent 会话
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-9 gap-2.5"
          data-slot="create-terminal-session-item"
          disabled={creatingTerminal}
          onSelect={handleCreateTerminal}
        >
          <Terminal className="size-4 text-muted-foreground" aria-hidden="true" />
          {creatingTerminal ? "正在创建终端会话..." : "终端会话"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    triggerButton
  );

  return (
    <>
      {hasProxy ? (
        menuButton
      ) : (
        <Tooltip
          open={!hasProxy ? tipOpen : undefined}
          onOpenChange={!hasProxy ? setTipOpen : undefined}
        >
          <TooltipTrigger asChild>{menuButton}</TooltipTrigger>
          <TooltipContent side="top">{hasProxy ? "新建会话" : "请先连接开发机"}</TooltipContent>
        </Tooltip>
      )}
      <CreateSessionDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function CreateSessionTypeSheet({
  open,
  creatingTerminal,
  onOpenChange,
  onCreateAgent,
  onCreateTerminal,
}: {
  open: boolean;
  creatingTerminal: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateAgent: () => void;
  onCreateTerminal: () => void;
}) {
  const suppressRestoreFocusRef = useRef(false);

  function chooseSessionType(create: () => void) {
    suppressRestoreFocusRef.current = true;
    create();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        overlayClassName="bg-black/10 dark:bg-black/30"
        className="inset-x-2 w-auto rounded-t-xl border border-border/80 bg-background px-3 pb-[max(theme(spacing.4),env(safe-area-inset-bottom))] pt-3 shadow-2xl"
        data-slot="create-session-type-sheet"
        focusSurfaceOnOpen
        onCloseAutoFocus={(event) => {
          if (!suppressRestoreFocusRef.current) return;
          suppressRestoreFocusRef.current = false;
          event.preventDefault();
        }}
      >
        <SheetHeader className="px-1 pb-1 pt-0 text-left">
          <SheetTitle>新建</SheetTitle>
        </SheetHeader>
        <div className="grid gap-2 pb-1" data-slot="create-session-type-options">
          <Button
            type="button"
            variant="ghost"
            className="min-h-12 justify-start gap-3 rounded-md px-3 text-left"
            data-slot="create-agent-session-sheet-item"
            onClick={() => chooseSessionType(onCreateAgent)}
          >
            <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
            Agent 会话
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="min-h-12 justify-start gap-3 rounded-md px-3 text-left"
            data-slot="create-terminal-session-sheet-item"
            disabled={creatingTerminal}
            onClick={() => chooseSessionType(onCreateTerminal)}
          >
            <Terminal className="size-4 text-muted-foreground" aria-hidden="true" />
            {creatingTerminal ? "正在创建终端会话..." : "终端会话"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
