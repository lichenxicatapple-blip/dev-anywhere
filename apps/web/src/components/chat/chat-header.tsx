// 桌面端有常驻侧栏，返回入口只在移动端显示。
import {
  ArrowLeft,
  Columns3,
  ImageIcon,
  Keyboard,
  Lightbulb,
  Maximize,
  Mic,
  Minus,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Rows3,
  Search,
  Type,
  Upload,
  Zap,
} from "lucide-react";
import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { PTY_INITIAL_MAX_COLS, PTY_INITIAL_MAX_ROWS } from "@dev-anywhere/shared";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";
import {
  getEffectiveChatContentFontSize,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  MOBILE_CHAT_CONTENT_FONT_SIZE_MIN,
} from "@/lib/chat-font-size";
import { useAppStore } from "@/stores/app-store";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { getPtyShortcutPreset } from "@/lib/pty-shortcuts";
import { PTY_MIN_COLS, PTY_MIN_ROWS, type PtyResizeAction } from "@/lib/pty-fit-geometry";
import { formatUnlockedTerminalPathName } from "@/lib/format-session-name";
import { useFileStore } from "@/stores/file-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useScreenWakeLockScope } from "@/hooks/use-screen-wake-lock";
import { toast } from "@/components/toast";
import { uploadFileAndShowToast } from "@/lib/file-upload-payload";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { SessionRenameDialog } from "@/components/session/session-rename-dialog";
import { TerminalDimensionInput } from "./terminal-dimension-input";
import { screenWakeLockManager } from "@/lib/screen-wake-lock-manager";
import { cn } from "@/lib/utils";
import { DEFAULT_VOICE_PILOT_STATE, useVoicePilotStore } from "@/voice/voice-pilot-store";
import { voiceAudioSession, type VoiceAudioSessionLease } from "@/voice/browser-audio-session";
import { voicePlaybackContext } from "@/voice/voice-playback-context";
import { recordVoicePilotDiagnostic } from "@/voice/voice-pilot-diagnostics";
import { voicePilotWakeLockScopeKey } from "@/voice/voice-pilot-wake-lock";
import { resolveVoiceSpeechSource } from "@/voice/speech-capture";
import { getUploadPickerPolicy } from "@/lib/upload-picker-policy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ChatHeaderProps {
  sessionId: string;
  mode?: "json" | "pty";
  onFind: () => void;
  onResizeTerminal?: (action: PtyResizeAction) => void;
}

function splitPtyTitle(title: string): { indicator?: string; label: string } {
  const [indicator, space, ...rest] = Array.from(title);
  if (indicator && space === " " && rest.length > 0) {
    return { indicator, label: rest.join("") };
  }
  return { label: title };
}

function ChatSessionTitle({ title, isPtyTitle }: { title: string; isPtyTitle: boolean }) {
  if (!isPtyTitle) {
    return <>{title}</>;
  }

  const { indicator, label } = splitPtyTitle(title);
  return (
    <span className="inline-flex items-center justify-center max-w-full min-w-0 font-mono font-normal">
      {indicator && (
        <span className="inline-block w-[1.25ch] shrink-0 text-center" aria-hidden="true">
          {indicator}
        </span>
      )}
      <span className="truncate">{indicator ? ` ${label}` : label}</span>
    </span>
  );
}

function microphoneErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "没有麦克风权限，请在浏览器里允许访问麦克风。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "未检测到可用麦克风。";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "麦克风正在被其他应用占用。";
  }
  return err instanceof Error ? err.message : "无法访问麦克风。";
}

async function ensureMicrophoneReady(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持麦克风访问。");
  }
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error(microphoneErrorMessage(err), { cause: err });
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

const menuItemClass = "min-h-9 gap-2.5";
const menuLabelClass = "px-2 pb-1 pt-2 text-xs font-semibold text-muted-foreground";
const terminalSizeControls = [
  {
    axis: "cols",
    label: "列数",
    unit: "列",
    Icon: Columns3,
    min: PTY_MIN_COLS,
    max: PTY_INITIAL_MAX_COLS,
  },
  {
    axis: "rows",
    label: "行数",
    unit: "行",
    Icon: Rows3,
    min: PTY_MIN_ROWS,
    max: PTY_INITIAL_MAX_ROWS,
  },
] as const;

function ChatMenuIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="chat-menu-icon"
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ShortcutKeyIcon({ label }: { label: string }) {
  return (
    <ChatMenuIcon className="relative">
      <Keyboard className="size-4" aria-hidden="true" />
      <span className="absolute -right-1.5 -top-1 flex h-3 min-w-4 items-center justify-center rounded-[3px] border border-border bg-popover px-0.5 font-mono text-[7px] leading-none text-muted-foreground shadow-sm">
        {label}
      </span>
    </ChatMenuIcon>
  );
}

export function ChatHeader({ sessionId, mode, onFind, onResizeTerminal }: ChatHeaderProps) {
  const homePath = useFileStore((s) => s.homePath);
  const uploadPickerPolicy = getUploadPickerPolicy();
  const navigate = useNavigate();
  const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === sessionId));
  // PTY 模式 Claude CLI 运行时会通过 OSC 0 改终端标题 (Working/带工具名等),
  // proxy 转发为 terminal_title, dispatcher 写到 ptyTitles, 这里优先展示
  const ptyTitle = useSessionStore((s) => s.ptyTitles[sessionId]);
  const ptyGeometry = useSessionStore((s) => s.ptyGeometryBySessionId[sessionId]);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const chatContentFontSize = useAppStore((s) => s.chatContentFontSize);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const adjustPtyFontSize = useAppStore((s) => s.adjustPtyFontSize);
  const adjustChatContentFontSize = useAppStore((s) => s.adjustChatContentFontSize);
  const setChatContentFontSize = useAppStore((s) => s.setChatContentFontSize);
  const resetPtyFontSize = useAppStore((s) => s.resetPtyFontSize);
  const resetChatContentFontSize = useAppStore((s) => s.resetChatContentFontSize);
  const forceHardwareInput = useAppStore((s) => s.inputModePreference === "hardware");
  const renameSession = useSessionStore((s) => s.renameSession);
  const ptyAutoYesKey = ptyAutoYesSessionKey(selectedProxyId, sessionId);
  const ptyAutoYesSupported = session?.provider !== "codex";
  const ptyAutoYesEnabled = useSessionStore((s) =>
    ptyAutoYesSupported && ptyAutoYesKey ? Boolean(s.ptyAutoYesBySessionKey[ptyAutoYesKey]) : false,
  );
  const setPtyAutoYes = useSessionStore((s) => s.setPtyAutoYes);
  const nativeTouchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const touchEditingSurface = nativeTouchEditingSurface && !forceHardwareInput;
  const isPty = mode === "pty" || session?.mode === "pty";
  const shortcuts = getPtyShortcutPreset(session ?? {}).menu;
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuPtyFocusRef = useRef<HTMLTextAreaElement | null>(null);
  const menuClosedByEscapeRef = useRef(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const isTerminalSession = session?.kind === "terminal";
  const screenWakeLock = useScreenWakeLockScope(sessionId);
  const voicePilot = useVoicePilotStore(
    (s) => s.bySessionId[sessionId] ?? DEFAULT_VOICE_PILOT_STATE,
  );
  const enableVoicePilot = useVoicePilotStore((s) => s.enable);
  const disableVoicePilot = useVoicePilotStore((s) => s.disable);
  const hasLockedName = Boolean(session?.nameLocked && session?.name);
  const terminalPathTitle = formatUnlockedTerminalPathName(session, homePath);
  const title =
    (hasLockedName && session?.name) ||
    terminalPathTitle ||
    (isPty && ptyTitle) ||
    session?.name ||
    sessionId.slice(0, 8);
  const isLivePtyTitle = Boolean(isPty && !isTerminalSession && ptyTitle && !hasLockedName);
  const fontSize = isPty
    ? ptyFontSize
    : getEffectiveChatContentFontSize(chatContentFontSize, touchEditingSurface);
  const minFontSize =
    !isPty && touchEditingSurface ? MOBILE_CHAT_CONTENT_FONT_SIZE_MIN : MIN_CHAT_FONT_SIZE;
  const resetFontSize = isPty ? resetPtyFontSize : resetChatContentFontSize;
  const [voicePilotConfirmOpen, setVoicePilotConfirmOpen] = useState(false);
  const [voicePilotStarting, setVoicePilotStarting] = useState(false);
  const voicePilotControlsWakeLock = voicePilot.enabled;
  const screenWakeLockChecked = screenWakeLock.active || voicePilotControlsWakeLock;
  const screenWakeLockDisabled =
    screenWakeLock.pending || !screenWakeLock.supported || voicePilotControlsWakeLock;

  function adjustFontSize(delta: number) {
    if (isPty) {
      adjustPtyFontSize(delta);
      return;
    }
    if (touchEditingSurface) {
      setChatContentFontSize(fontSize + delta);
      return;
    }
    adjustChatContentFontSize(delta);
  }

  function toggleScreenWakeLock() {
    void screenWakeLock.toggle().catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    });
  }

  async function toggleVoicePilot(nextChecked: boolean | "indeterminate") {
    if (isPty || isTerminalSession) {
      toast.info("Voice Pilot 目前适用于聊天会话。");
      return;
    }
    if (nextChecked !== true) {
      disableVoicePilot(sessionId);
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    try {
      const result = await relay.requestVoiceConfig();
      if (!result.config?.configured) {
        toast.info("请先在设置里配置 Voice Pilot。");
        return;
      }
      setVoicePilotConfirmOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmVoicePilotStart(): Promise<void> {
    setVoicePilotStarting(true);
    let audioSessionLease: VoiceAudioSessionLease | null = null;
    let wakeLockHandedOff = false;
    const wakeLockScopeKey = voicePilotWakeLockScopeKey(sessionId);
    try {
      recordVoicePilotDiagnostic({
        sessionId,
        scope: "runtime",
        event: "wake-lock-requested",
        details: {
          userActivationActive: navigator.userActivation?.isActive ?? false,
          visibilityState: document.visibilityState,
          secureContext: window.isSecureContext,
        },
      });
      const wakeLockReady = screenWakeLockManager.enable(wakeLockScopeKey).then(
        () => {
          recordVoicePilotDiagnostic({
            sessionId,
            scope: "runtime",
            event: "wake-lock-acquired",
          });
        },
        (error: unknown) => {
          recordVoicePilotDiagnostic({
            sessionId,
            scope: "runtime",
            event: "wake-lock-failed",
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
          throw new Error("屏幕常亮请求被浏览器拒绝，Voice Pilot 未开启。", {
            cause: error,
          });
        },
      );
      // Browser-gated capabilities must be requested directly from this click.
      // iPadOS otherwise loses user activation before React effects are flushed.
      audioSessionLease = voiceAudioSession.acquire("capture");
      const playbackReady = voicePlaybackContext.prepare();
      const speechSource = resolveVoiceSpeechSource();
      const speechSourceReady =
        speechSource.kind === "microphone" ? ensureMicrophoneReady() : Promise.resolve();
      await Promise.all([wakeLockReady, playbackReady, speechSourceReady]);
      enableVoicePilot(sessionId);
      wakeLockHandedOff = true;
      setVoicePilotConfirmOpen(false);
    } catch (err) {
      recordVoicePilotDiagnostic({
        sessionId,
        scope: "runtime",
        event: "startup-failed",
        details: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      audioSessionLease?.release();
      if (!wakeLockHandedOff) {
        await screenWakeLockManager.disable(wakeLockScopeKey).catch(() => undefined);
      }
      setVoicePilotStarting(false);
    }
  }

  // PTY 模式上传文件: 触发隐藏 input → 读字节 → relay.uploadFile → 把返回路径作为
  // "@<path> " 文本写到终端 stdin, 用户接着回车或自己拼到命令里 (与图片粘贴同形状)。
  // 媒体 / 文件分两个 input: "上传照片或视频" 用 image/*,video/* 进入系统相册；
  // 普通文件入口由 upload picker policy 处理 Safari 与 Android 的系统选择器差异。
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  async function handleFilePicked(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const path = await uploadFileAndShowToast({ relay, sessionId, file });
    if (path) sendRemoteInputRaw(sessionId, `@${path} `);
  }

  async function handleRename(targetSessionId: string, name: string): Promise<void> {
    const relay = relayClientRef;
    if (!relay) {
      throw new Error("请先连接开发机");
    }
    const result = await relay.renameSession(targetSessionId, name);
    if (!result.success) {
      throw new Error(result.error ?? "重命名失败");
    }
    renameSession(targetSessionId, result.name ?? name);
    toast.success("已重命名会话");
  }

  return (
    <div
      className="border-b border-border bg-card pt-[env(safe-area-inset-top)] shrink-0"
      data-slot="chat-header"
    >
      <div className="dev-chat-shell-rail-inset" data-slot="chat-header-rail-inset">
        <div
          className="grid min-h-12 w-full grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center"
          data-slot="chat-header-rail"
        >
          <div className="flex justify-start">
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              onClick={() => navigate("/sessions")}
              aria-label="返回会话列表"
              data-slot="chat-back-button"
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          </div>
          {/* 中间列 text-center + truncate: 长标题省略号, 短标题居中 */}
          <span
            className="text-sm font-semibold truncate text-center px-2"
            data-slot="chat-session-title"
          >
            <ChatSessionTitle title={title} isPtyTitle={isLivePtyTitle} />
          </span>
          <DropdownMenu
            modal={false}
            onOpenChange={(open) => {
              if (open) menuClosedByEscapeRef.current = false;
              else setShortcutsOpen(false);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                ref={menuTriggerRef}
                variant="ghost"
                size="icon-sm"
                className="justify-self-end"
                aria-label="会话操作"
                data-slot="chat-overflow-trigger"
                onPointerDownCapture={(event) => {
                  if (event.currentTarget.getAttribute("data-state") === "open") return;
                  const focused = document.activeElement;
                  const entry = focused?.closest('[data-slot="pty-keepalive-entry"]');
                  menuPtyFocusRef.current =
                    isPty &&
                    focused instanceof HTMLTextAreaElement &&
                    focused.matches('[data-slot="pty-host"] .xterm-helper-textarea') &&
                    entry?.getAttribute("data-session-id") === sessionId &&
                    entry.getAttribute("data-active") === "true"
                      ? focused
                      : null;
                }}
                onKeyDownCapture={(event) => {
                  if (["Enter", " ", "ArrowDown"].includes(event.key)) {
                    menuPtyFocusRef.current = null;
                  }
                }}
              >
                <MoreVertical aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-max min-w-44 max-w-[calc(100vw-1rem)] data-[state=open]:animate-none"
              data-slot="chat-overflow-menu"
              onEscapeKeyDown={(event) => {
                if (
                  event.target instanceof HTMLElement &&
                  event.target.matches('[data-terminal-dimension-input][data-editing="true"]')
                ) {
                  event.preventDefault();
                  return;
                }
                menuClosedByEscapeRef.current = true;
              }}
              onInteractOutside={() => {
                // Radix can unmount the menu before the browser blurs its input.
                const focused = document.activeElement;
                if (
                  focused instanceof HTMLInputElement &&
                  focused.hasAttribute("data-terminal-dimension-input")
                ) {
                  focused.blur();
                }
              }}
              onCloseAutoFocus={(event) => {
                const previousInput = menuPtyFocusRef.current;
                const closedByEscape = menuClosedByEscapeRef.current;
                menuPtyFocusRef.current = null;
                menuClosedByEscapeRef.current = false;
                const entry = previousInput?.closest('[data-slot="pty-keepalive-entry"]');
                const focused = document.activeElement;
                // Only an Escape dismissal resumes the PTY that owned focus before a pointer
                // opened this menu. Other menu actions and keyboard navigation retain Radix's
                // focus behavior, including handing focus to search, dialogs, or outside controls.
                if (
                  event.defaultPrevented ||
                  !closedByEscape ||
                  !isPty ||
                  !previousInput?.isConnected ||
                  entry?.getAttribute("data-session-id") !== sessionId ||
                  entry.getAttribute("data-active") !== "true" ||
                  (focused !== document.body &&
                    focused !== document.documentElement &&
                    focused !== menuTriggerRef.current &&
                    focused !== previousInput &&
                    !focused?.closest('[data-slot="chat-overflow-menu"]'))
                ) {
                  return;
                }
                event.preventDefault();
                previousInput.focus({ preventScroll: true });
              }}
            >
              <DropdownMenuLabel className={menuLabelClass}>会话</DropdownMenuLabel>
              <DropdownMenuItem
                className={menuItemClass}
                data-slot="chat-menu-find"
                onSelect={onFind}
              >
                <ChatMenuIcon>
                  <Search aria-hidden="true" />
                </ChatMenuIcon>
                在会话中查找
              </DropdownMenuItem>
              <DropdownMenuItem
                className={menuItemClass}
                data-slot="chat-menu-rename"
                onSelect={() => setRenameOpen(true)}
              >
                <ChatMenuIcon>
                  <Pencil aria-hidden="true" />
                </ChatMenuIcon>
                重命名
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={screenWakeLockChecked}
                className={cn(
                  "min-h-9 justify-start gap-2.5 pl-2 pr-8 [&>span:first-child]:left-auto [&>span:first-child]:right-2",
                  !screenWakeLock.supported && !screenWakeLockChecked && "pr-2",
                )}
                disabled={screenWakeLockDisabled}
                data-slot="chat-menu-screen-wake-lock-item"
                onCheckedChange={toggleScreenWakeLock}
              >
                <ChatMenuIcon>
                  <Lightbulb aria-hidden="true" />
                </ChatMenuIcon>
                <span className="min-w-0 flex-1">
                  {!screenWakeLock.supported
                    ? screenWakeLock.unavailableReason === "insecure-context"
                      ? "屏幕常亮（需要 HTTPS）"
                      : "屏幕常亮（浏览器不支持）"
                    : voicePilotControlsWakeLock
                      ? "屏幕常亮（Voice Pilot 控制）"
                      : "屏幕常亮"}
                </span>
              </DropdownMenuCheckboxItem>
              {isPty && !isTerminalSession && ptyAutoYesSupported && (
                <DropdownMenuCheckboxItem
                  checked={ptyAutoYesEnabled}
                  className="min-h-9 justify-start gap-2.5 pl-2 pr-8 [&>span:first-child]:left-auto [&>span:first-child]:right-2"
                  disabled={!ptyAutoYesKey}
                  data-slot="chat-menu-pty-auto-yes-item"
                  onCheckedChange={(checked) => {
                    if (ptyAutoYesKey) {
                      setPtyAutoYes(ptyAutoYesKey, checked === true);
                    }
                  }}
                >
                  <ChatMenuIcon>
                    <Zap aria-hidden="true" />
                  </ChatMenuIcon>
                  <span className="min-w-0 flex-1">Always yes</span>
                </DropdownMenuCheckboxItem>
              )}
              {!isPty && !isTerminalSession && (
                <DropdownMenuCheckboxItem
                  checked={voicePilot.enabled}
                  className="min-h-9 justify-start gap-2.5 pl-2 pr-8 [&>span:first-child]:left-auto [&>span:first-child]:right-2"
                  data-slot="chat-menu-voice-pilot-item"
                  onCheckedChange={toggleVoicePilot}
                >
                  <ChatMenuIcon>
                    <Mic aria-hidden="true" />
                  </ChatMenuIcon>
                  <span className="min-w-0 flex-1">Voice Pilot</span>
                </DropdownMenuCheckboxItem>
              )}
              <DropdownMenuSeparator />
              {session?.mode === "pty" &&
                session.ptyOwner === "proxy-hosted" &&
                onResizeTerminal && (
                  <>
                    <DropdownMenuLabel className={menuLabelClass}>终端尺寸</DropdownMenuLabel>
                    <DropdownMenuItem
                      className={menuItemClass}
                      data-slot="chat-menu-fit-terminal"
                      disabled={!connected || !proxyOnline || session.state === "error"}
                      onSelect={() => onResizeTerminal("fit")}
                    >
                      <ChatMenuIcon>
                        <Maximize aria-hidden="true" />
                      </ChatMenuIcon>
                      按窗口调整终端尺寸
                    </DropdownMenuItem>
                    {terminalSizeControls.map(({ axis, label, unit, Icon, min, max }) => {
                      const value = ptyGeometry?.[axis];
                      const disabled =
                        !connected ||
                        !proxyOnline ||
                        session.state === "error" ||
                        value === undefined;
                      return (
                        <div
                          key={axis}
                          role="group"
                          aria-label={label}
                          className="flex min-h-9 items-center gap-2.5 px-2 text-sm"
                          data-slot={`chat-menu-${axis}-control`}
                        >
                          <ChatMenuIcon>
                            <Icon aria-hidden="true" />
                          </ChatMenuIcon>
                          <span>{label}</span>
                          <div className="inline-flex shrink-0 items-center gap-2">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-[22px] rounded-[5px] bg-muted/45 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                              disabled={disabled || (value !== undefined && value <= min)}
                              aria-label={`减少${unit}`}
                              data-slot={`chat-menu-decrease-${axis}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onResizeTerminal(`decrease-${axis}`);
                              }}
                            >
                              <Minus aria-hidden="true" />
                            </Button>
                            <TerminalDimensionInput
                              key={`${sessionId}-${axis}`}
                              axis={axis}
                              label={label}
                              value={value}
                              min={min}
                              max={max}
                              disabled={disabled}
                              onCommit={(next) => onResizeTerminal({ axis, value: next })}
                            />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-[22px] rounded-[5px] bg-muted/45 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                              disabled={disabled || (value !== undefined && value >= max)}
                              aria-label={`增加${unit}`}
                              data-slot={`chat-menu-increase-${axis}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onResizeTerminal(`increase-${axis}`);
                              }}
                            >
                              <Plus aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                    <DropdownMenuSeparator />
                  </>
                )}
              {isPty && (
                <>
                  <DropdownMenuSub open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
                    <DropdownMenuSubTrigger
                      className={cn(menuItemClass, "[&>svg:last-child]:ml-0")}
                      data-slot="chat-menu-shortcuts-trigger"
                      onClick={(event) => {
                        if (shortcutsOpen) {
                          event.preventDefault();
                          setShortcutsOpen(false);
                        }
                      }}
                    >
                      <ChatMenuIcon>
                        <Keyboard aria-hidden="true" />
                      </ChatMenuIcon>
                      发送快捷键
                    </DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent
                        // Radix flips side menus but does not shift them horizontally.
                        // Move only the overflowing width back inside the viewport.
                        className={cn(
                          "min-w-44 max-w-[calc(100vw-1rem)] max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto",
                          "data-[side=left]:translate-x-[max(0px,calc(100%-var(--radix-dropdown-menu-content-available-width)))]",
                          "data-[side=right]:-translate-x-[max(0px,calc(100%-var(--radix-dropdown-menu-content-available-width)))]",
                        )}
                        sideOffset={4}
                        collisionPadding={8}
                        data-slot="chat-menu-shortcuts"
                      >
                        {shortcuts.map((shortcut) => (
                          <DropdownMenuItem
                            key={shortcut.id}
                            className={menuItemClass}
                            data-slot={`chat-menu-send-${shortcut.id}`}
                            disabled={
                              !connected ||
                              !proxyOnline ||
                              session?.mode !== "pty" ||
                              session.state === "error"
                            }
                            onSelect={() => sendRemoteInputRaw(sessionId, shortcut.data)}
                          >
                            <ShortcutKeyIcon label={shortcut.display} />
                            发送 {shortcut.key}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                </>
              )}
              {isPty && !isTerminalSession ? (
                <>
                  <DropdownMenuLabel className={menuLabelClass}>文件</DropdownMenuLabel>
                  <DropdownMenuItem
                    className={menuItemClass}
                    data-slot="chat-menu-upload-image"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    <ChatMenuIcon>
                      <ImageIcon aria-hidden="true" />
                    </ChatMenuIcon>
                    上传照片或视频
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={menuItemClass}
                    data-slot="chat-menu-upload-file"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ChatMenuIcon>
                      <Upload aria-hidden="true" />
                    </ChatMenuIcon>
                    上传文件
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuLabel className={menuLabelClass}>字号</DropdownMenuLabel>
              <div className="px-2 pb-1" data-slot="chat-menu-font-control">
                <div
                  className="inline-grid min-h-9 grid-cols-[1.25rem_auto] items-center gap-x-2.5 py-1"
                  data-slot="chat-menu-font-row"
                >
                  <ChatMenuIcon>
                    <Type aria-hidden="true" />
                  </ChatMenuIcon>
                  <div
                    className="col-start-2 inline-flex w-fit shrink-0 items-center gap-2"
                    data-slot="chat-menu-font-stepper"
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-[22px] rounded-[5px] bg-muted/45 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      disabled={fontSize <= minFontSize}
                      aria-label="字号变小"
                      data-slot="chat-menu-font-smaller"
                      onClick={(event) => {
                        event.stopPropagation();
                        adjustFontSize(-1);
                      }}
                    >
                      <Minus aria-hidden="true" />
                    </Button>
                    <span
                      className="flex h-[22px] min-w-11 items-center justify-center px-1 text-sm font-medium leading-none tabular-nums text-foreground"
                      data-slot="chat-menu-font-size"
                    >
                      {fontSize}px
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-[22px] rounded-[5px] bg-muted/45 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      disabled={fontSize >= MAX_CHAT_FONT_SIZE}
                      aria-label="字号变大"
                      data-slot="chat-menu-font-larger"
                      onClick={(event) => {
                        event.stopPropagation();
                        adjustFontSize(1);
                      }}
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>
              <DropdownMenuItem
                className={menuItemClass}
                data-slot="chat-menu-font-reset"
                onClick={resetFontSize}
              >
                <ChatMenuIcon>
                  <RotateCcw aria-hidden="true" />
                </ChatMenuIcon>
                <span data-slot="chat-menu-font-reset-label">恢复默认</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <SessionRenameDialog
        open={renameOpen}
        sessionId={sessionId}
        initialName={session?.name}
        onOpenChange={setRenameOpen}
        onRename={handleRename}
      />
      <Dialog
        open={voicePilotConfirmOpen && !voicePilot.enabled}
        onOpenChange={(open) => {
          if (!voicePilotStarting) setVoicePilotConfirmOpen(open);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          data-slot="voice-pilot-wake-lock-dialog"
          focusSurfaceOnOpen
        >
          <DialogHeader>
            <DialogTitle>开启 Voice Pilot？</DialogTitle>
            <DialogDescription>开启后会持续聆听并保持屏幕常亮，停止后自动恢复。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={voicePilotStarting}
              onClick={() => setVoicePilotConfirmOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              data-slot="voice-pilot-confirm-start"
              disabled={voicePilotStarting}
              onClick={() => {
                void confirmVoicePilotStart();
              }}
            >
              {voicePilotStarting ? "正在开启..." : "开启 Voice Pilot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {isPty ? (
        <>
          <input
            ref={imageInputRef}
            type="file"
            accept={uploadPickerPolicy.mediaAccept}
            className="hidden"
            data-slot="chat-menu-upload-image-input"
            onChange={(event) => {
              void handleFilePicked(event);
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={uploadPickerPolicy.fileAccept}
            className="hidden"
            data-slot="chat-menu-upload-file-input"
            onChange={(event) => {
              void handleFilePicked(event);
            }}
          />
        </>
      ) : null}
    </div>
  );
}
