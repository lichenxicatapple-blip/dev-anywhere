// ChatPage: ChatHeader + StatusLine (4px 色带) + content(JSON/PTY) + JSON QuotePreviewBar/InputBar
// statusState 按优先级聚合 connection/terminated/approval/working/idle，StatusLine 放 Header 正下方
// PTY 模式由 xterm 自己承载逐键输入，不再保留下方聊天式命令输入框。
import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { clearLastChatRoute, consumeRestoredTarget } from "@/lib/route-restore";
import { toast } from "@/components/toast";
import { ChatHeader } from "@/components/chat/chat-header";
import { ChatJsonView } from "@/components/chat/chat-json-view";
import { ChatPtyView } from "@/components/chat/chat-pty-view";
import { InputBar } from "@/components/chat/input-bar";
import { FileDownloadProvider } from "@/components/chat/file-download-link";
import { ImagePreviewProvider } from "@/components/chat/image-preview";
import { QuotePreviewBar } from "@/components/chat/quote-preview-bar";
import { StatusLine } from "@/components/chat/status-line";
import { EmptyState } from "@/components/shell/empty-state";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { isRouteSessionEnded, resolveChatPresentation, resolveChatStatusState } from "./chat-status";
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
  const presentation = resolveChatPresentation({ connected, proxyOnline, routeSessionEnded });
  const navigate = useNavigate();
  const location = useLocation();
  // iOS/Android 软键盘高度: 用 paddingBottom 把整个 flex-col 列上挤, flex-1 min-h-0 的 PTY/JSON 区会同步缩短, 底部气泡/PTY 尾行自动跟 InputBar 一起挪到键盘之上
  const kbOffset = useVisualViewportBottomOffset();

  // 区分 "用户主动敲 chat URL / refresh" vs "AppShell auto-restore 把我拽来"。
  // 仅当当前 URL 等于 RESTORED_TARGET 时算后者, 一次性消费, 避免后续手动回访被重定向。
  const wasAutoRestoredRef = useRef(false);
  useEffect(() => {
    const target = consumeRestoredTarget();
    if (target && target === `${location.pathname}${location.search}`) {
      wasAutoRestoredRef.current = true;
    }
    // 只在挂载时读一次, 不依赖 location 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      .catch((err: unknown) => {
        console.error("[chat] requestSessionResources failed", { sessionId: id }, err);
      });
    void relay
      .requestAgentStatuses(id)
      .then((statuses) => {
        const sessionStore = useSessionStore.getState();
        for (const status of statuses) {
          sessionStore.setAgentStatus(status.sessionId, status.payload);
        }
      })
      .catch((err: unknown) => {
        console.error("[chat] requestAgentStatuses failed", { sessionId: id }, err);
      });
  }, [id, connected, proxyOnline, routeSessionEnded]);

  // session 通过任何路径被终止 (用户主动终止 / 子进程退出广播) 后清掉上次 chat 路由记录,
  // 否则下次冷启动还会自动跳到一个已经不存在的 sessionId, 体验上多走一步。
  useEffect(() => {
    if (routeSessionEnded) clearLastChatRoute();
  }, [routeSessionEnded]);

  // auto-restore 拽过来 + session 已死 → silent 退到 /sessions, 替换历史记录。
  // 用户手敲 URL / 直接 refresh 的不走这条, 让他们看到 TerminatedSessionPanel 不被静默打断。
  useEffect(() => {
    if (!wasAutoRestoredRef.current) return;
    if (!routeSessionEnded) return;
    toast.info("上次会话已结束");
    navigate("/sessions", { replace: true });
  }, [routeSessionEnded, navigate]);

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
    <ImagePreviewProvider sessionId={id}>
      <FileDownloadProvider sessionId={id}>
        <div
          className="flex flex-col h-full"
          style={{ paddingBottom: kbOffset || "env(safe-area-inset-bottom)" }}
          data-keyboard-offset={kbOffset}
        >
          <ChatHeader sessionId={id} mode={mode} />
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
            {presentation === "relay-disconnected" ? (
              <ConnectionLostPanel variant="relay" />
            ) : presentation === "proxy-offline" ? (
              <ConnectionLostPanel variant="proxy" />
            ) : presentation === "session-ended" ? (
              // wasAutoRestored 时副作用马上跳走, 这里渲染空白避免一帧 TerminatedSessionPanel 闪烁
              wasAutoRestoredRef.current ? null : <TerminatedSessionPanel mode={mode} />
            ) : mode === "pty" ? (
              <ChatPtyView sessionId={id} ptyOwner={session?.ptyOwner} />
            ) : (
              <ChatJsonView sessionId={id} />
            )}
          </div>
          {mode === "json" && presentation === "ok" && (
            <>
              <QuotePreviewBar sessionId={id} />
              <div className="px-4 py-2" data-slot="input-bar-region">
                <div className="dev-message-rail mx-auto w-full">
                  <InputBar sessionId={id} />
                </div>
              </div>
            </>
          )}
        </div>
      </FileDownloadProvider>
    </ImagePreviewProvider>
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
      <h2 className="text-lg font-semibold">{mode === "pty" ? "终端连接已断开" : "会话已终止"}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {mode === "pty" ? "页面已停止接收终端画面和输入。" : "当前会话已经结束，输入已停止。"}
      </p>
    </div>
  );
}

function ConnectionLostPanel({ variant }: { variant: "relay" | "proxy" }) {
  const title = variant === "relay" ? "中继连接已中断" : "开发机未连接";
  const message =
    variant === "relay"
      ? "与中继服务器的 WebSocket 连接已断开，正在尝试重新建立连接。"
      : "目标开发机当前未在线。请确认开发机上 dev-anywhere proxy 守护进程在运行，或返回会话列表选择其他开发机。";
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center bg-background"
      data-slot="connection-lost-panel"
      data-variant={variant}
      role="status"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
