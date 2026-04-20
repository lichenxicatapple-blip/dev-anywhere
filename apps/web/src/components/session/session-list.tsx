// SessionList dual-layout 组件（Plan 10-03 正式实现，覆盖 10-01b stub）
// layout=page: 移动端全屏列表 + 底部浮动 "+ 新建会话" 按钮
// layout=sidebar: 桌面侧栏中段；"+ 新建会话" 由 Sidebar 底部 slot 通过 CreateSessionButton 单独承载
//
// sidebar.tsx 已在 10-01b 通过 import 绑定本模块路径（SessionList + CreateSessionButton 两个 export）
// 本 Plan 只替换 body；新增 export 或改 props 签名会破坏与 10-02 的 W3 并行，禁止
//
// 历史会话区 (HistoryList) 渲染在活跃列表下方, 即使无活跃会话但有历史时也可见,
// 只要历史非空就提供 "继续上次对话" 的入口, 空态仅在 active=0 && history=0 时出现
import { useEffect, useState } from "react";
import { useNavigate, useMatch } from "react-router";
import { Plus, Loader2 } from "lucide-react";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shell/empty-state";
import { cn } from "@/lib/utils";
import { SessionRow } from "./session-row";
import { HistoryList } from "./history-list";
import { CreateSessionDialog } from "./create-session-dialog";
import { relayClientRef } from "@/hooks/use-relay-setup";

interface SessionListProps {
  layout: "page" | "sidebar";
}

export function SessionList({ layout }: SessionListProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const sessionListLoaded = useSessionStore((s) => s.sessionListLoaded);
  const historyCount = useSessionStore((s) => s.historySessions.length);
  // 选中态绑 URL: /chat/:id 命中当前行才高亮, 离开 chat 页 (/sessions, /) 自动全部无高亮
  const chatMatch = useMatch("/chat/:id");
  const activeSessionId = chatMatch?.params.id ?? null;
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const proxyListLoaded = useAppStore((s) => s.proxyListLoaded);
  // 冷启动刷新时, proxy_list / session_list envelope 均未到, 显示 spinner 避免 no-proxy / no-session 一闪而过
  const isLoading = !proxyListLoaded || (hasProxy && !sessionListLoaded);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  // 每分钟推一次 now，让 SessionRow 里的 "N 分钟前" 跟着走；store 不动也能滚
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  function handleRowClick(sessionId: string, mode: "pty" | "json" | undefined) {
    const resolvedMode = mode ?? "json";
    // D-15: URL 更新但不触发页面级 transition（AppShell 是父路由，Outlet 内直接切换）
    navigate(`/chat/${sessionId}?mode=${resolvedMode}`, { replace: false });
  }

  function handleTerminate(sessionId: string) {
    const relay = relayClientRef;
    relay?.sendControl({ type: "session_terminate", sessionId });
  }

  const hasActive = sessions.length > 0;

  // 加载中 / 无 proxy: 两个 layout 分别走各自的空态; 其他情况统一渲染 active + history 两个 section,
  // 各自内部做 "暂无..." 提示, 而不是 short-circuit 出一个大 EmptyState
  if (layout === "sidebar" && (isLoading || !hasProxy)) {
    return (
      <>
        <div className="px-4 py-3 text-sm text-muted-foreground/70">
          {isLoading ? "连接中..." : "请先选择 Proxy"}
        </div>
        <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
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
            · {sessions.length}
          </span>
        ) : null}
      </h3>
    ) : null;

  const activeListElement = hasActive ? (
    <ul role="list" className="flex flex-col w-full min-w-0">
      {sessions.map((s) => (
        <SessionRow
          key={s.sessionId}
          session={s}
          selected={s.sessionId === activeSessionId}
          now={now}
          onClick={() => handleRowClick(s.sessionId, s.mode)}
          onTerminate={() => handleTerminate(s.sessionId)}
        />
      ))}
    </ul>
  ) : (
    <div
      className="px-4 py-3 text-sm text-muted-foreground/70"
      data-slot="active-empty"
    >
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
    </>
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
