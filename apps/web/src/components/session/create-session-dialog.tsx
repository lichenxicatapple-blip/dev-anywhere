// 新建会话入口：选择工作目录、交互方式和开发机上的 Agent CLI。
// 终端模式由开发机 proxy 托管真实 CLI；聊天模式保留结构化消息流。
import { type FocusEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useSessionStore } from "@/stores/session-store";
import { useFileStore } from "@/stores/file-store";
import { toast } from "@/components/toast";
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
import { FilePathPicker } from "@/components/chat/file-path-picker";
import { useMediaQuery } from "@/hooks/use-media-query";
import { AgentCliPicker } from "./agent-cli-picker";
import {
  CODEX_PERMISSION_MODE_OPTIONS,
  normalizePermissionModeForProvider,
  PERMISSION_MODE_OPTIONS,
  type PermissionMode,
  type ProviderId,
  PROVIDER_LABEL,
  providerStatus,
  type SessionMode,
  submitSessionCreate,
} from "./create-session-submit";

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const isDesktop = useMediaQuery("(min-width: 768px)");

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
    void handleSubmitSessionCreate();
  }

  const permissionOptions =
    provider === "codex" ? CODEX_PERMISSION_MODE_OPTIONS : PERMISSION_MODE_OPTIONS;
  const selectedStatus = providerStatus(provider, agentCli);
  const createDisabled = submitting || savingCliPath || selectedStatus.disabled;

  function normalizePermissionMode(nextProvider: ProviderId) {
    const normalized = normalizePermissionModeForProvider(nextProvider, permissionMode);
    if (normalized !== permissionMode) setPermissionMode(normalized);
  }

  async function handleSubmitSessionCreate(cwdOverride?: string) {
    setMissingCwd(null);
    setSubmitting(true);
    try {
      const result = await submitSessionCreate({
        relay: relayClientRef,
        agentCli,
        form: {
          cwd: cwdOverride ?? cwd,
          name,
          provider,
          permissionMode,
          mode,
        },
      });
      if (result.type === "success") {
        useSessionStore.getState().addSession(result.session);
        // session 已建好就该入 store（其他地方刷新会看到），但若用户已关闭弹窗就别再
        // 强行 navigate / 重置表单——他们已经放弃了这次创建，路由跳转是反预期的。
        if (!latestOpen.current) {
          return;
        }
        onOpenChange(false);
        resetForm();
        navigate(result.route);
        return;
      }

      if (result.type === "missing_cwd") {
        setMissingCwd(result.path);
      }
      toast.error(result.message);
      if (result.type === "validation_error" || result.type === "relay_missing") {
        return;
      }
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
      <AgentCliPicker
        agentCli={agentCli}
        provider={provider}
        isDesktop={isDesktop}
        editingCliProvider={editingCliProvider}
        cliPathInput={cliPathInput}
        savingCliPath={savingCliPath}
        onProviderChange={(nextProvider) => {
          setProvider(nextProvider);
          normalizePermissionMode(nextProvider);
        }}
        onOpenCliPathEditor={openCliPathEditor}
        onCliPathInputChange={setCliPathInput}
        onCancelCliPathEditor={() => {
          setEditingCliProvider(null);
          setCliPathInput("");
        }}
        onSaveCliPath={() => void saveCliPath()}
      />
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
          onOpenAutoFocus={(event) => event.preventDefault()}
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
