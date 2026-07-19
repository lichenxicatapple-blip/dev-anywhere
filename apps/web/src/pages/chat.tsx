// ChatPage: ChatHeader + StatusLine (4px 色带) + content(JSON/PTY) + JSON QuotePreviewBar/InputBar
// statusState 按优先级聚合 connection/terminated/approval/working/idle，StatusLine 放 Header 正下方
// PTY 模式由 xterm 自己承载逐键输入，不再保留下方聊天式命令输入框。
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { clearLastChatRoute, consumeRestoredTarget } from "@/lib/route-restore";
import { toast } from "@/components/toast";
import { ChatHeader } from "@/components/chat/chat-header";
import { ChatJsonView } from "@/components/chat/chat-json-view";
import { PtyKeepAliveViewport } from "@/components/chat/pty-keepalive-provider";
import { InputBar } from "@/components/chat/input-bar";
import { FileDownloadProvider } from "@/components/chat/file-download-link";
import { ImagePreviewProvider } from "@/components/chat/image-preview";
import { QuotePreviewBar } from "@/components/chat/quote-preview-bar";
import { StatusLine } from "@/components/chat/status-line";
import { PtyApprovalHint } from "@/components/chat/pty-approval-hint";
import { VoicePilotController } from "@/components/chat/voice-pilot-controller";
import { VoicePilotStatus } from "@/components/chat/voice-pilot-status";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useVisualViewportInsets } from "@/hooks/use-visual-viewport";
import { useMediaQuery } from "@/hooks/use-media-query";
import { describeCurrentClientDevice } from "@/lib/client-device";
import {
  dismissFloatingKeyboardHint,
  isFloatingKeyboardHintDismissed,
  shouldShowFloatingKeyboardHint,
} from "@/lib/ipad-floating-keyboard-hint";
import {
  isRouteSessionEnded,
  resolveChatPresentation,
  resolveChatStatusState,
  shouldShowPtyApprovalHint,
} from "./chat-status";
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
  const findRequestSequenceRef = useRef(0);
  const [findRequest, setFindRequest] = useState<{
    sessionId: string;
    sequence: number;
  } | null>(null);
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === id));
  const isTerminalSession = session?.kind === "terminal";
  const sessionListLoaded = useSessionStore((s) => s.sessionListLoaded);
  const agentStatus = useSessionStore((s) => s.agentStatusBySessionId[id]);
  const ptyState = useSessionStore((s) => s.ptyStateBySessionId[id]);
  const ptyAutoYesKey = ptyAutoYesSessionKey(selectedProxyId, id);
  const ptyAutoYesEnabled = useSessionStore((s) =>
    ptyAutoYesKey ? Boolean(s.ptyAutoYesBySessionKey[ptyAutoYesKey]) : false,
  );
  const setPtyAutoYes = useSessionStore((s) => s.setPtyAutoYes);
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[id]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  const routeSessionEnded = isRouteSessionEnded(session, sessionListLoaded);
  const presentation = resolveChatPresentation({
    connected,
    proxyOnline,
    routeSessionEnded,
    sessionState: session?.state,
  });
  const navigate = useNavigate();
  const location = useLocation();
  // keyboardOffset 表示键盘是否打开/大概高度；layoutKbInset 才是当前 layout viewport 仍被
  // 键盘覆盖的物理 inset。Android Chrome 常会直接压缩 layout viewport，此时再 padding
  // 会二次避让，在 PTY controls 和键盘之间制造一条黑带。
  const { bottomOffset: kbOffset, layoutBottomInset: layoutKbInset } = useVisualViewportInsets();
  const inputModePreference = useAppStore((s) => s.inputModePreference);
  const adaptiveInputModality = useAppStore((s) => s.adaptiveInputModality);
  const setAdaptiveInputModality = useAppStore((s) => s.setAdaptiveInputModality);
  const softKeyboardDetected = kbOffset > 0;
  const hardwareInputActive =
    inputModePreference === "hardware" ||
    (inputModePreference === "auto" &&
      adaptiveInputModality === "hardware" &&
      !softKeyboardDetected);
  useEffect(() => {
    if (
      inputModePreference === "auto" &&
      adaptiveInputModality === "hardware" &&
      softKeyboardDetected
    ) {
      setAdaptiveInputModality("touch");
    }
  }, [adaptiveInputModality, inputModePreference, setAdaptiveInputModality, softKeyboardDetected]);
  const isLandscape = useMediaQuery("(orientation: landscape)");
  const [isIpadClient] = useState(() => describeCurrentClientDevice().osName === "iPad");
  const floatingKeyboardHintShownRef = useRef(false);
  const effectiveKbOffset = hardwareInputActive ? 0 : kbOffset;
  // layoutKbInset is already zero when the browser resizes the layout viewport and
  // non-zero only when the soft keyboard overlays it.
  const effectiveLayoutKbInset = hardwareInputActive ? 0 : layoutKbInset;

  useEffect(() => {
    const keyboardOpen = effectiveKbOffset > 0;
    if (!keyboardOpen) {
      floatingKeyboardHintShownRef.current = false;
      return;
    }
    if (
      !shouldShowFloatingKeyboardHint({
        isIpad: isIpadClient,
        isLandscape,
        isPty: mode === "pty",
        keyboardOpen,
        shownForCurrentKeyboardOpen: floatingKeyboardHintShownRef.current,
        dismissed: isFloatingKeyboardHintDismissed(),
      })
    ) {
      return;
    }

    floatingKeyboardHintShownRef.current = true;
    toast.info("可以缩小软键盘", {
      id: "ipad-floating-keyboard-hint",
      testId: "ipad-floating-keyboard-hint",
      description: "在键盘上双指向内捏合，即可切换为浮动键盘并扩大终端显示区域。",
      duration: 8000,
      classNames: {
        actionButton: "!h-11 !px-3",
      },
      action: {
        label: "不再显示",
        onClick: () => dismissFloatingKeyboardHint(),
      },
    });
  }, [effectiveKbOffset, isIpadClient, isLandscape, mode]);

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
    if (isTerminalSession) return;
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
  }, [id, connected, proxyOnline, routeSessionEnded, isTerminalSession]);

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
  const ptyWaitingApproval =
    !isTerminalSession &&
    mode === "pty" &&
    presentation === "ok" &&
    statusState === "waiting_approval";
  const showPtyApprovalHint = shouldShowPtyApprovalHint({
    ptyWaitingApproval,
    ptyAutoYesEnabled,
  });
  const activeFindRequest = findRequest?.sessionId === id ? findRequest.sequence : undefined;

  function requestFind(): void {
    findRequestSequenceRef.current += 1;
    setFindRequest({ sessionId: id, sequence: findRequestSequenceRef.current });
  }

  return (
    <ImagePreviewProvider sessionId={id}>
      <FileDownloadProvider sessionId={id}>
        <div
          className="flex flex-col h-full transition-[padding-bottom] duration-200 ease-out motion-reduce:transition-none"
          style={effectiveLayoutKbInset ? { paddingBottom: effectiveLayoutKbInset } : undefined}
          data-keyboard-offset={effectiveKbOffset}
          data-keyboard-layout-inset={effectiveLayoutKbInset}
        >
          <ChatHeader sessionId={id} mode={mode} onFind={requestFind} />
          {mode === "json" && presentation === "ok" && <VoicePilotController sessionId={id} />}
          {!isTerminalSession && !showPtyApprovalHint && <StatusLine state={statusState} />}
          {showPtyApprovalHint && (
            <PtyApprovalHint
              autoYesEnabled={ptyAutoYesEnabled}
              onAutoYesChange={(enabled) => {
                if (ptyAutoYesKey) setPtyAutoYes(ptyAutoYesKey, enabled);
              }}
            />
          )}
          <div className="flex-1 min-h-0 relative">
            {presentation === "session-ended" ? (
              // wasAutoRestored 时副作用马上跳走, 这里渲染空白避免一帧 TerminatedSessionPanel 闪烁
              wasAutoRestoredRef.current ? null : (
                <TerminatedSessionPanel mode={mode} />
              )
            ) : presentation === "session-error" ? (
              <FailedSessionPanel mode={mode} onBack={() => navigate("/sessions")} />
            ) : mode === "pty" ? (
              <PtyKeepAliveViewport
                sessionId={id}
                sessionKind={session?.kind}
                provider={session?.provider}
                ptyOwner={session?.ptyOwner}
                findRequest={activeFindRequest}
              />
            ) : (
              <ChatJsonView sessionId={id} findRequest={activeFindRequest} />
            )}
            {(presentation === "relay-disconnected" || presentation === "proxy-offline") && (
              // Overlay 不替代 chat 主体: PTY 视图 unmount 会销毁 xterm 实例, BackToBottom
              // hasNewMessages 等组件状态也丢. 重连后用户期待原状态续上, panel 浮在上层挡住即可。
              <ConnectionLostPanel
                variant={presentation === "relay-disconnected" ? "relay" : "proxy"}
              />
            )}
          </div>
          {mode === "json" && presentation === "ok" && (
            <>
              <QuotePreviewBar sessionId={id} />
              <div
                className={`dev-chat-input-rail-inset relative z-20 overflow-visible bg-background pt-2 transition-[padding-bottom] duration-200 ease-out motion-reduce:transition-none ${
                  effectiveLayoutKbInset > 0
                    ? "pb-2"
                    : "pb-[max(env(safe-area-inset-bottom),0.5rem)]"
                }`}
                data-slot="input-bar-region"
              >
                <div className="dev-message-rail mx-auto w-full">
                  <VoicePilotStatus sessionId={id} />
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

function FailedSessionPanel({ mode, onBack }: { mode: "json" | "pty"; onBack: () => void }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center"
      data-slot="failed-session-panel"
      role="alert"
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">
          {mode === "pty" ? "终端连接异常" : "会话连接异常"}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          与开发机上的进程通道已中断。请返回会话列表，终止后重新创建。
        </p>
      </div>
      <Button type="button" variant="outline" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        返回会话列表
      </Button>
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
      <h2 className="text-lg font-semibold">{mode === "pty" ? "终端连接已断开" : "会话已终止"}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {mode === "pty" ? "页面已停止接收终端画面和输入。" : "当前会话已经结束，输入已停止。"}
      </p>
    </div>
  );
}

function ConnectionLostPanel({ variant }: { variant: "relay" | "proxy" }) {
  const title = variant === "relay" ? "中继连接可能遇到问题" : "开发机连接可能遇到问题";
  const message =
    variant === "relay"
      ? "正在继续尝试连接中继服务器，网络恢复后会自动返回当前会话。"
      : "正在继续尝试连接开发机。若长时间没有恢复，请确认 DEV Anywhere 正在开发机上运行。";
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 px-6 text-center bg-background"
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
