// SessionList dual-layout 组件（Plan 10-03 正式实现，覆盖 10-01b stub）
// layout=page: 移动端全屏列表 + 底部浮动 "+ 新建会话" 按钮
// layout=sidebar: 桌面侧栏中段；"+ 新建会话" 由 Sidebar 底部 slot 通过 CreateSessionButton 单独承载
//
// sidebar.tsx 已在 10-01b 通过 import 绑定本模块路径（SessionList + CreateSessionButton 两个 export）
// 本 Plan 只替换 body；新增 export 或改 props 签名会破坏与 10-02 的 W3 并行，禁止
import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { useSessionStore } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/shell/empty-state";
import { SessionRow } from "./session-row";
import { CreateSessionDialog } from "./create-session-dialog";
import { relayClientRef } from "@/hooks/use-relay-setup";

interface SessionListProps {
  layout: "page" | "sidebar";
}

export function SessionList({ layout }: SessionListProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  function handleRowClick(sessionId: string, mode: "pty" | "json" | undefined) {
    const resolvedMode = mode ?? "json";
    useSessionStore.getState().setCurrentSession(sessionId, resolvedMode);
    // D-15: URL 更新但不触发页面级 transition（AppShell 是父路由，Outlet 内直接切换）
    navigate(`/chat/${sessionId}?mode=${resolvedMode}`, { replace: false });
  }

  function handleTerminate(sessionId: string) {
    const relay = relayClientRef;
    relay?.sendControl({ type: "session_terminate", sessionId });
  }

  if (sessions.length === 0) {
    if (layout === "sidebar") {
      return (
        <>
          <div className="p-4 text-xs text-muted-foreground">还没有会话</div>
          <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
        </>
      );
    }
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1">
          <EmptyState
            variant="no-session"
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus aria-hidden="true" />
                新建会话
              </Button>
            }
          />
        </div>
        <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
      </div>
    );
  }

  const listElement = (
    <ul role="list" className="flex flex-col">
      {sessions.map((s) => (
        <SessionRow
          key={s.sessionId}
          session={s}
          selected={s.sessionId === currentSessionId}
          onClick={() => handleRowClick(s.sessionId, s.mode)}
          onTerminate={() => handleTerminate(s.sessionId)}
        />
      ))}
    </ul>
  );

  if (layout === "page") {
    return (
      <div className="flex flex-col h-full">
        <ScrollArea className="flex-1">{listElement}</ScrollArea>
        <div className="p-4 border-t border-border">
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
  return (
    <>
      <ScrollArea className="h-full">{listElement}</ScrollArea>
      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

// 侧栏底部的 "+ 新建会话" 按钮触发器 —— 被 10-01b sidebar.tsx 直接 import
// card 样式（border + hover）与顶部 proxy chip 在视觉层级上同级：均为 scope 层的操作
export function CreateSessionButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        className="w-full justify-start gap-2 h-10"
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" />
        新建会话
      </Button>
      <CreateSessionDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
