// ChatPage: ChatHeader + StatusLine (4px 色带) + content(JSON/PTY) + QuotePreviewBar + InputBar
// statusState 按优先级聚合 connection/approval/terminated/working/idle，StatusLine 放 Header 正下方
// InputBar 统一承载 JSON 与 PTY 两种模式；右侧不再有 SemanticActionPanel 侧栏
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { ChatHeader } from "@/components/chat/chat-header";
import { ChatJsonView } from "@/components/chat/chat-json-view";
import { ChatPtyView } from "@/components/chat/chat-pty-view";
import { InputBar } from "@/components/chat/input-bar";
import { QuotePreviewBar } from "@/components/chat/quote-preview-bar";
import { StatusLine, type StatusLineState } from "@/components/chat/status-line";
import { EmptyState } from "@/components/shell/empty-state";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";

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
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[id]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  // iOS/Android 软键盘高度: 用 paddingBottom 把整个 flex-col 列上挤, flex-1 min-h-0 的 PTY/JSON 区会同步缩短, 底部气泡/PTY 尾行自动跟 InputBar 一起挪到键盘之上
  const kbOffset = useVisualViewportBottomOffset();

  // 会话资源 (slash 命令列表 + @ 文件树) 按 session 请求:
  // proxy 侧按 session.cwd 推 command_list_push + file_tree_push, 不请求就拿不到数据
  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const relay = relayClientRef;
    if (!relay) return;
    relay.sendControl({ type: "session_resources_request", sessionId: id });
  }, [id, connected, proxyOnline]);

  // 单一权威信号: session.state（proxy 的 session_status envelope + pty_state 都写到这个字段）
  // pendingApprovals 与 session.state === "waiting_approval" 作 OR：审批推送可能比 session_status 早到
  const statusState: StatusLineState =
    !connected || !proxyOnline
      ? "disconnected"
      : pendingApprovals.some((a) => a.status === "pending") ||
          session?.state === "waiting_approval"
        ? "waiting_approval"
        : session?.state === "terminated"
          ? "terminated"
          : session?.state === "working"
            ? "working"
            : "idle";

  return (
    <div
      className="flex flex-col h-full"
      style={{ paddingBottom: kbOffset || "env(safe-area-inset-bottom)" }}
      data-keyboard-offset={kbOffset}
    >
      <ChatHeader sessionId={id} />
      <StatusLine state={statusState} />
      {mode === "pty" && statusState === "waiting_approval" && (
        <div
          role="status"
          aria-live="polite"
          data-slot="pty-approval-hint"
          className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs bg-[var(--color-status-warning)]/10 text-[var(--color-status-warning)] border-b border-[var(--color-status-warning)]/30"
        >
          <span aria-hidden="true">⏸</span>
          <span>等待审批</span>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {mode === "pty" ? <ChatPtyView sessionId={id} /> : <ChatJsonView sessionId={id} />}
      </div>
      <QuotePreviewBar sessionId={id} />
      <div className="p-2" data-slot="input-bar-region">
        <InputBar sessionId={id} mode={mode} />
      </div>
    </div>
  );
}
