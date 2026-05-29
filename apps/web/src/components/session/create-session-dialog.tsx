// 新建会话入口：选择工作目录、交互方式和开发机上的 Agent CLI。
// 终端模式由开发机 proxy 托管真实 CLI；聊天模式保留结构化消息流。
import { type FocusEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { PencilLine } from "lucide-react";
import type { AgentCliStatus, SessionInfo } from "@dev-anywhere/shared";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useSessionStore } from "@/stores/session-store";
import { useFileStore } from "@/stores/file-store";
import { toast } from "@/components/toast";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FilePathPicker } from "@/components/chat/file-path-picker";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useAppStore } from "@/stores/app-store";
import { resolveXtermThemeName } from "@/lib/xterm-theme";

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SessionMode = "pty" | "json";
type ProviderId = "claude" | "codex";
type PermissionMode = "default" | "auto" | "acceptEdits" | "plan" | "bypassPermissions";

const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "严格审批" },
  { value: "auto", label: "自动判定" },
  { value: "acceptEdits", label: "自动接受编辑" },
  { value: "plan", label: "只读规划" },
  { value: "bypassPermissions", label: "跳过全部审批" },
];
const CODEX_PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "严格审批" },
  { value: "auto", label: "自动判定" },
  { value: "bypassPermissions", label: "跳过全部审批" },
];
const SESSION_CREATE_TIMEOUT_MS = 15_000;
const MISSING_CWD_PREFIX = "工作目录不存在或不可访问:";
const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function extractMissingCwd(error: string, errorCode?: string): string | null {
  if (errorCode !== ControlErrorCode.PATH_NOT_FOUND || !error.startsWith(MISSING_CWD_PREFIX)) {
    return null;
  }
  const path = error.slice(MISSING_CWD_PREFIX.length).trim();
  return path || null;
}

function providerStatus(
  provider: ProviderId,
  agentCli: AgentCliStatus | null,
): { label: string; disabled: boolean; title?: string } {
  if (!agentCli) {
    return { label: "检测中", disabled: true };
  }
  const status = agentCli[provider];
  if (status.available) {
    return { label: "可用", disabled: false, title: status.command };
  }
  return { label: "未找到", disabled: true, title: status.error };
}

function providerTooltip(provider: ProviderId, status: ReturnType<typeof providerStatus>): string {
  if (status.title) {
    return status.disabled
      ? `${PROVIDER_LABEL[provider]}：${status.title}`
      : `${PROVIDER_LABEL[provider]} 路径：${status.title}`;
  }
  return `${PROVIDER_LABEL[provider]}：${status.label}`;
}

export function CreateSessionDialog({ open, onOpenChange }: CreateSessionDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [mode, setMode] = useState<SessionMode>("pty");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [submitting, setSubmitting] = useState(false);
  const [missingCwd, setMissingCwd] = useState<string | null>(null);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [editingCliProvider, setEditingCliProvider] = useState<ProviderId | null>(null);
  const [cliPathInput, setCliPathInput] = useState("");
  const [savingCliPath, setSavingCliPath] = useState(false);
  const cwdFieldRef = useRef<HTMLDivElement>(null);
  // open=false 时把 latestOpen.current 同步翻 false，submitSessionCreate 在 await 后据此跳过
  // 路由跳转——否则用户在创建中关掉弹窗会被强制带去 /chat/<id>，等同界面被劫持。
  const latestOpen = useRef(open);
  latestOpen.current = open;
  const navigate = useNavigate();
  const homePath = useFileStore((s) => s.homePath);
  const agentCli = useFileStore((s) => s.agentCli);
  const themePreference = useAppStore((s) => s.themePreference);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const systemPrefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const terminalTheme = resolveXtermThemeName(themePreference, systemPrefersDark);

  // 打开对话框时, 若 CWD 还没被用户改过, 用 homePath 作为默认起点
  useEffect(() => {
    if (open && !cwd && homePath) {
      setCwd(homePath);
    }
  }, [open, homePath, cwd]);

  useEffect(() => {
    if (!open) return;
    if (homePath && agentCli) return;
    const request = relayClientRef?.requestProxyInfo();
    if (!request) return;
    void request
      .then((info) => {
        const store = useFileStore.getState();
        store.setHomePath(info.homePath);
        store.setAgentCli(info.agentCli);
      })
      .catch((err: unknown) => {
        console.error("[create-session-dialog] requestProxyInfo failed", err);
      });
  }, [open, homePath, agentCli]);

  useEffect(() => {
    if (!cwdPickerOpen) return;

    function closePickerOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && cwdFieldRef.current?.contains(target)) return;
      window.setTimeout(() => setCwdPickerOpen(false), 0);
    }

    document.addEventListener("pointerdown", closePickerOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closePickerOnOutsidePointer, true);
  }, [cwdPickerOpen]);

  function resetForm() {
    setName("");
    setCwd("");
    setCwdPickerOpen(false);
    setProvider("claude");
    setMode("pty");
    setPermissionMode("default");
    setMissingCwd(null);
    setEditingCliProvider(null);
    setCliPathInput("");
    setSavingCliPath(false);
  }

  function handleSubmit() {
    submitSessionCreate();
  }

  const permissionOptions =
    provider === "codex" ? CODEX_PERMISSION_MODE_OPTIONS : PERMISSION_MODE_OPTIONS;
  const claudeStatus = providerStatus("claude", agentCli);
  const codexStatus = providerStatus("codex", agentCli);
  const selectedStatus = providerStatus(provider, agentCli);
  const createDisabled = submitting || savingCliPath || selectedStatus.disabled;
  const selectedCli = agentCli?.[provider];

  function normalizePermissionMode(nextProvider: ProviderId) {
    if (nextProvider === "codex") {
      const supported = CODEX_PERMISSION_MODE_OPTIONS.some(
        (option) => option.value === permissionMode,
      );
      if (!supported) setPermissionMode("default");
    }
  }

  async function submitSessionCreate(cwdOverride?: string) {
    const targetCwd = (cwdOverride ?? cwd).trim();
    if (!targetCwd) {
      toast.error("请输入工作目录");
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const submittedName = name.trim();
    const submittedMode = mode;
    const submittedProvider = provider;
    if (selectedStatus.disabled) {
      const reason = agentCli?.[provider]?.error;
      toast.error(
        reason
          ? `${PROVIDER_LABEL[provider]} 不可用：${reason}`
          : `${PROVIDER_LABEL[provider]} 暂不可用`,
      );
      return;
    }
    setMissingCwd(null);
    setSubmitting(true);
    try {
      const ctrl = await relay.createSession(
        {
          cwd: targetCwd,
          name: submittedName || undefined,
          mode,
          provider,
          ...(mode === "pty" ? { terminalTheme } : {}),
          permissionMode,
        },
        SESSION_CREATE_TIMEOUT_MS,
      );
      if (ctrl.error || !ctrl.sessionId) {
        const missingPath = extractMissingCwd(ctrl.error ?? "", ctrl.errorCode);
        if (missingPath) {
          setMissingCwd(missingPath);
          toast.error("找不到这个工作目录");
          return;
        }
        toast.error(`创建失败：${ctrl.error ?? "未知错误"}`);
        return;
      }

      const resolvedName = ctrl.name?.trim() || undefined;
      const newSession: SessionInfo = {
        sessionId: ctrl.sessionId,
        name: resolvedName,
        ...(ctrl.nameLocked !== undefined ? { nameLocked: ctrl.nameLocked } : {}),
        state: "idle",
        mode: ctrl.mode ?? submittedMode,
        provider: ctrl.provider ?? submittedProvider,
        ptyOwner: ctrl.ptyOwner,
      };
      useSessionStore.getState().addSession(newSession);
      // session 已建好就该入 store（其他地方刷新会看到），但若用户已关闭弹窗就别再
      // 强行 navigate / 重置表单——他们已经放弃了这次创建，路由跳转是反预期的。
      if (!latestOpen.current) {
        return;
      }
      onOpenChange(false);
      resetForm();
      navigate(`/chat/${ctrl.sessionId}?mode=${ctrl.mode ?? submittedMode}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateDirectory(path: string): Promise<string | null> {
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return null;
    }
    try {
      const result = await relay.createDirectory(path);
      if (!result.success) {
        toast.error(`目录创建失败：${result.error ?? "未知错误"}`);
        return null;
      }
      setCwd(result.path);
      setMissingCwd(null);
      toast.success("目录已创建");
      return result.path;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  function openCliPathEditor(targetProvider: ProviderId) {
    const status = agentCli?.[targetProvider];
    setEditingCliProvider(targetProvider);
    setCliPathInput(status?.command ?? status?.suggestions?.[0] ?? "");
  }

  async function saveCliPath() {
    if (!editingCliProvider) return;
    const path = cliPathInput.trim();
    if (!path) {
      toast.error("请输入 Agent CLI 路径");
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    setSavingCliPath(true);
    try {
      const result = await relay.updateAgentCliPath(editingCliProvider, path);
      if (result.error || !result.agentCli) {
        toast.error(`路径保存失败：${result.error ?? "未知错误"}`);
        return;
      }
      useFileStore.getState().setAgentCli(result.agentCli);
      toast.success(`${PROVIDER_LABEL[editingCliProvider]} 路径已保存`);
      setEditingCliProvider(null);
      setCliPathInput("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCliPath(false);
    }
  }

  function handleModeChange(nextMode: SessionMode) {
    setMode(nextMode);
    normalizePermissionMode(provider);
  }

  function handleCwdFieldBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocus = event.relatedTarget;
    if (nextFocus instanceof Node && cwdFieldRef.current?.contains(nextFocus)) return;
    window.setTimeout(() => setCwdPickerOpen(false), 0);
  }

  const form = (
    <form
      className="flex min-w-0 flex-col gap-4"
      data-slot="create-session-form"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">名称（可选）</span>
        <input
          type="text"
          name="dev-anywhere-session-name"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-h-11 min-w-0 rounded-md border border-border bg-input px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-h-0 md:text-sm"
          placeholder="自动生成"
        />
      </label>
      <div
        ref={cwdFieldRef}
        className="relative flex min-w-0 flex-col gap-2"
        onBlur={handleCwdFieldBlur}
      >
        <span id="create-session-cwd-label" className="text-sm">
          工作目录
        </span>
        <input
          id="create-session-cwd"
          type="text"
          aria-labelledby="create-session-cwd-label"
          name="dev-anywhere-session-cwd"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={cwd}
          onFocus={() => setCwdPickerOpen(true)}
          onChange={(e) => {
            setCwd(e.target.value);
            setMissingCwd(null);
          }}
          placeholder="输入绝对路径"
          className="min-h-11 min-w-0 rounded-md border border-border bg-input px-3 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-h-0 md:text-sm"
        />
        {cwdPickerOpen ? (
          <FilePathPicker
            mode="select"
            dirsOnly
            filter={cwd}
            title="选择下一级目录"
            onCreateDirectory={handleCreateDirectory}
            onSelect={(path) => {
              setCwd(path);
              setMissingCwd(null);
              setCwdPickerOpen(true);
            }}
          />
        ) : null}
      </div>
      {missingCwd ? (
        <section
          role="status"
          aria-live="polite"
          className="rounded-md border border-primary/50 bg-primary/10 p-3"
        >
          <p className="text-sm font-medium">工作目录不存在</p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{missingCwd}</p>
        </section>
      ) : null}
      <section aria-label="交互方式" className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm">交互方式</span>
          <span className="text-xs text-muted-foreground">
            {mode === "pty" ? "完整终端" : "聊天消息"}
          </span>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            aria-pressed={mode === "pty"}
            onClick={() => handleModeChange("pty")}
            className={cn(
              "flex min-h-14 min-w-0 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mode === "pty" ? "border-primary/70 bg-primary/10" : "border-border bg-muted/20",
            )}
          >
            <span className="text-sm font-medium">终端模式</span>
            <span className="text-xs text-muted-foreground">像本地终端一样操作</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === "json"}
            onClick={() => handleModeChange("json")}
            className={cn(
              "flex min-h-14 min-w-0 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mode === "json" ? "border-primary/70 bg-primary/10" : "border-border bg-muted/20",
            )}
          >
            <span className="text-sm font-medium">聊天模式</span>
            <span className="text-xs text-muted-foreground">气泡式对话，支持 Voice Pilot</span>
          </button>
        </div>
      </section>
      <section aria-label="Agent CLI" className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm">Agent CLI</span>
          <span className="text-xs text-muted-foreground">选择要启动的 CLI</span>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={provider === "claude"}
                aria-label="Claude Code"
                aria-disabled={claudeStatus.disabled}
                onClick={() => setProvider("claude")}
                className={cn(
                  "flex min-h-14 min-w-0 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  provider === "claude"
                    ? "border-primary/70 bg-primary/10"
                    : "border-border bg-muted/20",
                )}
              >
                <span className="text-sm font-medium">Claude Code</span>
                <span
                  className={cn(
                    "text-xs text-muted-foreground",
                    claudeStatus.disabled && agentCli && "text-destructive",
                  )}
                >
                  {claudeStatus.label}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[min(520px,calc(100vw-2rem))]">
              <span className="break-all font-mono text-xs">
                {providerTooltip("claude", claudeStatus)}
              </span>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={provider === "codex"}
                aria-label="Codex"
                aria-disabled={codexStatus.disabled}
                onClick={() => {
                  setProvider("codex");
                  normalizePermissionMode("codex");
                }}
                className={cn(
                  "flex min-h-14 min-w-0 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  provider === "codex"
                    ? "border-primary/70 bg-primary/10"
                    : "border-border bg-muted/20",
                )}
              >
                <span className="text-sm font-medium">Codex</span>
                <span
                  className={cn(
                    "text-xs text-muted-foreground",
                    codexStatus.disabled && agentCli && "text-destructive",
                  )}
                >
                  {codexStatus.label}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[min(520px,calc(100vw-2rem))]">
              <span className="break-all font-mono text-xs">
                {providerTooltip("codex", codexStatus)}
              </span>
            </TooltipContent>
          </Tooltip>
        </div>
        <div
          className="relative min-w-0 rounded-md border border-border bg-muted/20 px-3 py-2.5 md:p-3"
          data-slot="agent-cli-path-card"
        >
          {editingCliProvider === provider ? (
            <>
              <p className="mb-1 text-xs text-muted-foreground">CLI 路径</p>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">CLI 路径</span>
                  <input
                    type="text"
                    list={`agent-cli-path-${editingCliProvider}`}
                    value={cliPathInput}
                    onChange={(event) => setCliPathInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveCliPath();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingCliProvider(null);
                        setCliPathInput("");
                      }
                    }}
                    placeholder={
                      editingCliProvider === "claude"
                        ? "/home/dev/.local/bin/claude"
                        : "/home/dev/.local/bin/codex"
                    }
                    className="min-h-11 w-full rounded-md border border-border bg-input px-3 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-10 md:min-h-0 md:text-sm"
                  />
                  <datalist id={`agent-cli-path-${editingCliProvider}`}>
                    {(agentCli?.[editingCliProvider].suggestions ?? []).map((path) => (
                      <option key={path} value={path} />
                    ))}
                  </datalist>
                </label>
                <div className="flex shrink-0 justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 shrink-0 rounded px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground md:h-8 md:min-h-0"
                    onClick={() => {
                      setEditingCliProvider(null);
                      setCliPathInput("");
                    }}
                    disabled={savingCliPath}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11 shrink-0 rounded px-2.5 text-xs font-medium md:h-8 md:min-h-0"
                    onClick={() => void saveCliPath()}
                    disabled={savingCliPath || !cliPathInput.trim()}
                  >
                    {savingCliPath ? "保存中..." : "保存路径"}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              {isDesktop ? (
                <>
                  <p className="mb-1 text-xs text-muted-foreground">CLI 路径</p>
                  <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
                    <p
                      className={cn(
                        "flex h-10 min-w-0 flex-1 items-center truncate font-mono text-sm",
                        selectedCli?.available ? "text-foreground" : "text-destructive",
                      )}
                      title={selectedCli?.command ?? selectedCli?.error}
                    >
                      {selectedCli?.command ?? selectedCli?.error ?? "等待检测结果"}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 min-h-0 shrink-0 self-end rounded px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground sm:self-auto"
                      onClick={() => openCliPathEditor(provider)}
                    >
                      指定路径
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="pr-11 text-xs text-muted-foreground">CLI 路径</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 size-11 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                    aria-label="指定路径"
                    onClick={() => openCliPathEditor(provider)}
                  >
                    <PencilLine className="size-4" aria-hidden="true" />
                  </Button>
                  <p
                    className={cn(
                      "mt-1 min-w-0 break-all pr-11 font-mono text-sm leading-5",
                      selectedCli?.available ? "text-foreground" : "text-destructive",
                    )}
                    title={selectedCli?.command ?? selectedCli?.error}
                  >
                    {selectedCli?.command ?? selectedCli?.error ?? "等待检测结果"}
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </section>
      <label className="flex min-w-0 flex-col gap-2">
        <span className="text-sm">权限模式</span>
        <Select
          value={permissionMode}
          onValueChange={(value) => setPermissionMode(value as PermissionMode)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {permissionOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 md:min-h-0"
          onClick={() => onOpenChange(false)}
          disabled={submitting}
        >
          取消
        </Button>
        <Button type="submit" className="min-h-11 md:min-h-0" disabled={createDisabled}>
          {submitting ? "创建中..." : "创建"}
        </Button>
      </DialogFooter>
    </form>
  );

  if (!isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="inset-x-2 max-h-[calc(100dvh-0.75rem)] w-auto overflow-x-hidden overflow-y-auto rounded-t-xl border bg-background px-4 pb-[max(theme(spacing.4),env(safe-area-inset-bottom))] pt-3"
          data-slot="create-session-dialog"
        >
          <SheetHeader className="px-0 pb-1 pt-0 text-left">
            <SheetTitle>新建会话</SheetTitle>
          </SheetHeader>
          {form}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!w-[calc(100vw-2rem)] !max-w-none max-h-[calc(100dvh-2rem)] overflow-y-auto sm:!w-[44rem]"
        data-slot="create-session-dialog"
        // 阻止 Radix 默认 focus 第一个 input ("名称"). mobile 上自动 focus 立刻弹软键盘,
        // visual viewport 高度被键盘吃掉 ~300px, dialog 下半部分 (Agent CLI / 权限模式 /
        // 创建按钮) 整体落在键盘下方, 用户即便 force tap 也命中不到。Radix 阻止
        // autofocus 后 focus 留在 trigger; ESC 仍能关闭 dialog, dialog 内 Tab 链路也仍然正常。
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
