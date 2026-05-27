// 桌面端有常驻侧栏，返回入口只在移动端显示。
import {
  ArrowLeft,
  ImageIcon,
  Keyboard,
  Lightbulb,
  Mic,
  Minus,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Type,
  Upload,
} from "lucide-react";
import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
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
} from "@/components/ui/dropdown-menu";
import { useSessionStore } from "@/stores/session-store";
import {
  getEffectiveChatContentFontSize,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  MOBILE_CHAT_CONTENT_FONT_SIZE_MIN,
} from "@/lib/chat-font-size";
import { useAppStore } from "@/stores/app-store";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useScreenWakeLockScope } from "@/hooks/use-screen-wake-lock";
import { toast } from "@/components/toast";
import { uploadFileAndShowToast } from "@/lib/file-upload-payload";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { SessionRenameDialog } from "@/components/session/session-rename-dialog";
import { cn } from "@/lib/utils";
import { DEFAULT_VOICE_PILOT_STATE, useVoicePilotStore } from "@/voice/voice-pilot-store";
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

export function ChatHeader({ sessionId, mode }: ChatHeaderProps) {
  const navigate = useNavigate();
  const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === sessionId));
  // PTY 模式 Claude CLI 运行时会通过 OSC 0 改终端标题 (Working/带工具名等),
  // proxy 转发为 terminal_title, dispatcher 写到 ptyTitles, 这里优先展示
  const ptyTitle = useSessionStore((s) => s.ptyTitles[sessionId]);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const chatContentFontSize = useAppStore((s) => s.chatContentFontSize);
  const adjustPtyFontSize = useAppStore((s) => s.adjustPtyFontSize);
  const adjustChatContentFontSize = useAppStore((s) => s.adjustChatContentFontSize);
  const setChatContentFontSize = useAppStore((s) => s.setChatContentFontSize);
  const resetPtyFontSize = useAppStore((s) => s.resetPtyFontSize);
  const resetChatContentFontSize = useAppStore((s) => s.resetChatContentFontSize);
  const desktopInteractionMode = useAppStore((s) => s.desktopInteractionMode);
  const renameSession = useSessionStore((s) => s.renameSession);
  const nativeTouchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const touchEditingSurface = nativeTouchEditingSurface && !desktopInteractionMode;
  const isPty = mode === "pty" || session?.mode === "pty";
  const screenWakeLock = useScreenWakeLockScope(sessionId);
  const voicePilot = useVoicePilotStore(
    (s) => s.bySessionId[sessionId] ?? DEFAULT_VOICE_PILOT_STATE,
  );
  const enableVoicePilot = useVoicePilotStore((s) => s.enable);
  const disableVoicePilot = useVoicePilotStore((s) => s.disable);
  const hasLockedName = Boolean(session?.nameLocked && session?.name);
  const title =
    (hasLockedName && session?.name) ||
    (isPty && ptyTitle) ||
    session?.name ||
    sessionId.slice(0, 8);
  const isLivePtyTitle = Boolean(isPty && ptyTitle && !hasLockedName);
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
    if (isPty) {
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
    try {
      await ensureMicrophoneReady();
      enableVoicePilot(sessionId);
      setVoicePilotConfirmOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setVoicePilotStarting(false);
    }
  }

  // PTY 模式上传文件: 触发隐藏 input → 读字节 → relay.uploadFile → 把返回路径作为
  // "@<path> " 文本写到终端 stdin, 用户接着回车或自己拼到命令里 (与图片粘贴同形状)。
  // 图片 / 文件分两个 input: 部分 Android Chrome (vivo 等 OEM 定制) 在点击没设
  // accept 的 file input 时会预申请相机权限。拆开后"上传文件"路径用排除 image/video
  // 的 accept, 不再触发相机授权弹窗。
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
          className="dev-message-rail mx-auto grid min-h-12 w-full grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center"
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
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="justify-self-end"
                aria-label="会话操作"
                data-slot="chat-overflow-trigger"
              >
                <MoreVertical aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-max min-w-44 max-w-[calc(100vw-1rem)]"
              data-slot="chat-overflow-menu"
            >
              <DropdownMenuLabel className={menuLabelClass}>会话</DropdownMenuLabel>
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
                className="min-h-9 justify-start gap-2.5 pl-2 pr-8 [&>span:first-child]:left-auto [&>span:first-child]:right-2"
                disabled={screenWakeLockDisabled}
                data-slot="chat-menu-screen-wake-lock-item"
                onCheckedChange={toggleScreenWakeLock}
              >
                <ChatMenuIcon>
                  <Lightbulb aria-hidden="true" />
                </ChatMenuIcon>
                <span className="min-w-0 flex-1">
                  {!screenWakeLock.supported
                    ? "屏幕常亮（浏览器不支持）"
                    : voicePilotControlsWakeLock
                      ? "屏幕常亮（Voice Pilot 控制）"
                      : "屏幕常亮"}
                </span>
              </DropdownMenuCheckboxItem>
              {!isPty && (
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
              {isPty ? (
                <>
                  {/* Tab / ⇧Tab / ^T / ^C / ^B / 清空 已挪到移动端控制条; 这里只留
                  低频且不适合常驻浮层的 Ctrl+O。 */}
                  <DropdownMenuLabel className={menuLabelClass}>快捷键</DropdownMenuLabel>
                  <DropdownMenuItem
                    className={menuItemClass}
                    data-slot="chat-menu-send-ctrl-o"
                    onClick={() => sendRemoteInputRaw(sessionId, "\x0f")}
                  >
                    <ShortcutKeyIcon label="^O" />
                    发送 Ctrl+O
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className={menuLabelClass}>文件</DropdownMenuLabel>
                  <DropdownMenuItem
                    className={menuItemClass}
                    data-slot="chat-menu-upload-image"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    <ChatMenuIcon>
                      <ImageIcon aria-hidden="true" />
                    </ChatMenuIcon>
                    上传图片
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
                    className="col-start-2 inline-flex w-fit shrink-0 items-center gap-0"
                    data-slot="chat-menu-font-stepper"
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-5 rounded-[5px] bg-muted/45 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
                      className="flex h-5 min-w-7 items-center justify-center text-xs tabular-nums text-foreground"
                      data-slot="chat-menu-font-size"
                    >
                      {fontSize}px
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-5 rounded-[5px] bg-muted/45 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
        <DialogContent className="sm:max-w-md" data-slot="voice-pilot-wake-lock-dialog">
          <DialogHeader>
            <DialogTitle>开启 Voice Pilot？</DialogTitle>
            <DialogDescription>
              开启后会自动保持屏幕常亮，直到你停止 Voice Pilot。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border bg-muted/35 p-3 text-sm leading-6 text-muted-foreground">
            <p>运行期间不能单独关闭这个常亮状态。</p>
            <p>长时间使用可能会显著增加电量消耗和设备发热。</p>
          </div>
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
            accept="image/*"
            className="hidden"
            data-slot="chat-menu-upload-image-input"
            onChange={(event) => {
              void handleFilePicked(event);
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="application/*,text/*"
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
