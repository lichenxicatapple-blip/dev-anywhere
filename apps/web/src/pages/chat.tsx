// ChatPage: ChatHeader + StatusLine (4px 色带) + content(JSON/PTY) + JSON QuotePreviewBar/InputBar
// statusState 按优先级聚合 connection/terminated/approval/working/idle，StatusLine 放 Header 正下方
// PTY 模式由 xterm 自己承载逐键输入，不再保留下方聊天式命令输入框。
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { ChatHeader } from "@/components/chat/chat-header";
import { ChatJsonView } from "@/components/chat/chat-json-view";
import { ChatPtyView } from "@/components/chat/chat-pty-view";
import { InputBar } from "@/components/chat/input-bar";
import { QuotePreviewBar } from "@/components/chat/quote-preview-bar";
import { StatusLine } from "@/components/chat/status-line";
import { EmptyState } from "@/components/shell/empty-state";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { isRouteSessionEnded, resolveChatStatusState } from "./chat-status";
import { useCommandStore } from "@/stores/command-store";
import { useFileStore } from "@/stores/file-store";

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const mode = (searchParams.get("mode") ?? "json") as "json" | "pty";

  if (!id) {
    return <EmptyState variant="no-session" />;
  }
  return <ChatPageInner id={id} mode={mode} />;
}

function ChatPageInner({ id, mode }: { id: string; mode: "json" | "pty" }) {
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === id));
  const sessionListLoaded = useSessionStore((s) => s.sessionListLoaded);
  const agentStatus = useSessionStore((s) => s.agentStatusBySessionId[id]);
  const ptyState = useSessionStore((s) => s.ptyStateBySessionId[id]);
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[id]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  const routeSessionEnded = isRouteSessionEnded(session, sessionListLoaded);
  // iOS/Android 软键盘高度: 用 paddingBottom 把整个 flex-col 列上挤, flex-1 min-h-0 的 PTY/JSON 区会同步缩短, 底部气泡/PTY 尾行自动跟 InputBar 一起挪到键盘之上
  const kbOffset = useVisualViewportBottomOffset();

  // 会话资源按 session 做 request-scoped snapshot，避免会话切换时沿用旧命令或旧文件树。
  useEffect(() => {
    if (!connected || !proxyOnline) return;
    if (routeSessionEnded) return;
    const relay = relayClientRef;
    if (!relay) return;
    void relay
      .requestSessionResources(id)
      .then((resources) => {
        useCommandStore.getState().setCommands(resources.commands);
        const fileStore = useFileStore.getState();
        fileStore.clearTree();
        if (resources.groups.length === 0) return;
        fileStore.setCwd(resources.groups[0].path);
        for (const group of resources.groups) {
          fileStore.setDirEntries(group.path, group.entries);
        }
      })
      .catch(() => undefined);
    void relay
      .requestAgentStatuses(id)
      .then((statuses) => {
        const sessionStore = useSessionStore.getState();
        for (const status of statuses) {
          sessionStore.setAgentStatus(status.sessionId, status.payload);
        }
      })
      .catch(() => undefined);
  }, [id, connected, proxyOnline, routeSessionEnded]);

  // 生命周期由 session.state / 活跃列表负责；provider 语义阶段优先读 agent_status，不再从 PTY 字节推断。
  // 当前路由 session 从活跃列表消失时，本页进入 terminated，避免残留审批/working 状态压过退出态。
  const statusState = resolveChatStatusState({
    connected,
    proxyOnline,
    routeSessionEnded,
    session,
    agentStatus,
    ptyState,
    hasPendingApproval: mode === "json" && pendingApprovals.some((a) => a.status === "pending"),
  });

  return (
    <div
      className="flex flex-col h-full"
      style={{ paddingBottom: kbOffset || "env(safe-area-inset-bottom)" }}
      data-keyboard-offset={kbOffset}
    >
      <ChatHeader sessionId={id} />
      <StatusLine state={statusState} />
      <div className="flex-1 min-h-0 relative">
        {mode === "pty" && statusState === "waiting_approval" && (
          <div
            role="status"
            aria-live="polite"
            data-slot="pty-approval-hint"
            className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 px-3 py-1.5 text-xs bg-[var(--color-status-warning)]/10 text-[var(--color-status-warning)] border-b border-[var(--color-status-warning)]/30"
          >
            <span aria-hidden="true">⏸</span>
            <span>等待审批</span>
          </div>
        )}
        {routeSessionEnded ? (
          <TerminatedSessionPanel mode={mode} />
        ) : mode === "pty" ? (
          <ChatPtyView sessionId={id} ptyOwner={session?.ptyOwner} />
        ) : (
          <ChatJsonView sessionId={id} />
        )}
      </div>
      {mode === "json" && !routeSessionEnded && (
        <>
          <QuotePreviewBar sessionId={id} />
          <div className="p-2" data-slot="input-bar-region">
            <InputBar sessionId={id} />
          </div>
        </>
      )}
    </div>
  );
}

function TerminatedSessionPanel({ mode }: { mode: "json" | "pty" }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center bg-background"
      data-slot="terminated-session-panel"
      role="status"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold">{mode === "pty" ? "远程视图已断开" : "会话已终止"}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {mode === "pty"
          ? "此终端会话已从远程视图断开，远端输入已停止。"
          : "当前会话已经结束，输入已停止。"}
      </p>
    </div>
  );
}
