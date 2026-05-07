// 新建会话入口：选择工作目录、会话模式和本机 Agent CLI。
// 终端模式由本机 proxy 托管真实 CLI；聊天模式保留结构化消息流。
import { type FocusEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { SessionInfo } from "@dev-anywhere/shared";
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
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FilePathPicker } from "@/components/chat/file-path-picker";

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SessionMode = "pty" | "json";
type PermissionMode = "default" | "auto" | "acceptEdits" | "plan" | "bypassPermissions";

const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "严格审批" },
  { value: "auto", label: "自动判定" },
  { value: "acceptEdits", label: "自动接受编辑" },
  { value: "plan", label: "只读规划" },
  { value: "bypassPermissions", label: "跳过全部审批" },
];
const SESSION_CREATE_TIMEOUT_MS = 15_000;
const MISSING_CWD_PREFIX = "工作目录不存在或不可访问:";

function extractMissingCwd(error: string): string | null {
  if (!error.startsWith(MISSING_CWD_PREFIX)) return null;
  const path = error.slice(MISSING_CWD_PREFIX.length).trim();
  return path || null;
}

export function CreateSessionDialog({ open, onOpenChange }: CreateSessionDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [mode, setMode] = useState<SessionMode>("pty");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [submitting, setSubmitting] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);
  const [missingCwd, setMissingCwd] = useState<string | null>(null);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const cwdFieldRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const homePath = useFileStore((s) => s.homePath);

  // 打开对话框时, 若 CWD 还没被用户改过, 用 homePath 作为默认起点
  useEffect(() => {
    if (open && !cwd && homePath) {
      setCwd(homePath);
    }
  }, [open, homePath, cwd]);

  // proxy_info 是创建会话目录选择的基础状态。HMR/重连后前端 store 可能丢失 homePath,
  // 这里在弹窗打开时补拉一次，避免只能靠硬刷新重新走完整绑定流程。
  useEffect(() => {
    if (!open || homePath) return;
    relayClientRef?.sendControl({ type: "proxy_info_request" });
  }, [open, homePath]);

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
  }

  function handleSubmit() {
    submitSessionCreate();
  }

  async function submitSessionCreate(cwdOverride?: string) {
    const targetCwd = (cwdOverride ?? cwd).trim();
    if (!targetCwd) {
      toast.error("请输入工作目录");
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      toast.error("连接尚未就绪");
      return;
    }
    const submittedName = name.trim();
    const submittedMode = mode;
    const submittedProvider = provider;
    setMissingCwd(null);
    setSubmitting(true);
    try {
      const ctrl = await relay.createSession(
        {
          cwd: targetCwd,
          mode,
          provider,
          ...(mode === "json" ? { permissionMode } : {}),
        },
        SESSION_CREATE_TIMEOUT_MS,
      );
      if (ctrl.error || !ctrl.sessionId) {
        const missingPath = extractMissingCwd(ctrl.error ?? "");
        if (missingPath) {
          setMissingCwd(missingPath);
          return;
        }
        toast.error(`创建失败：${ctrl.error ?? "未知错误"}`);
        return;
      }

      const newSession: SessionInfo = {
        sessionId: ctrl.sessionId,
        name: submittedName || undefined,
        state: "idle",
        mode: ctrl.mode ?? submittedMode,
        provider: ctrl.provider ?? submittedProvider,
        ptyOwner: ctrl.ptyOwner,
      };
      useSessionStore.getState().addSession(newSession);
      onOpenChange(false);
      resetForm();
      navigate(`/chat/${ctrl.sessionId}?mode=${ctrl.mode ?? submittedMode}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateMissingDirectory() {
    const relay = relayClientRef;
    if (!relay || !missingCwd) {
      toast.error("连接尚未就绪");
      return;
    }
    setCreatingDir(true);
    try {
      const result = await relay.createDirectory(missingCwd);
      if (!result.success) {
        toast.error(`目录创建失败：${result.error ?? "未知错误"}`);
        return;
      }
      setCwd(result.path);
      setMissingCwd(null);
      submitSessionCreate(result.path);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingDir(false);
    }
  }

  function handleModeChange(nextMode: SessionMode) {
    setMode(nextMode);
    if (nextMode === "json" && provider === "codex") {
      setProvider("claude");
    }
  }

  function handleCwdFieldBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocus = event.relatedTarget;
    if (nextFocus instanceof Node && cwdFieldRef.current?.contains(nextFocus)) return;
    window.setTimeout(() => setCwdPickerOpen(false), 0);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-sm">名称（可选）</span>
            <input
              type="text"
              name="dev-anywhere-session-name"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 px-3 rounded-md bg-input border border-border text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="自动生成"
            />
          </label>
          <div
            ref={cwdFieldRef}
            className="relative flex flex-col gap-2"
            onFocus={() => setCwdPickerOpen(true)}
            onBlur={handleCwdFieldBlur}
          >
            <label htmlFor="create-session-cwd" className="text-sm">
              工作目录
            </label>
            <input
              id="create-session-cwd"
              type="text"
              name="dev-anywhere-session-cwd"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={cwd}
              onChange={(e) => {
                setCwd(e.target.value);
                setMissingCwd(null);
              }}
              placeholder="输入绝对路径"
              className="h-9 px-3 rounded-md bg-input border border-border text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {cwdPickerOpen ? (
              <FilePathPicker
                mode="select"
                dirsOnly
                filter={cwd}
                title="选择下一级目录"
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
              className="flex flex-col gap-3 rounded-md border border-primary/50 bg-primary/10 p-3"
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">这个目录还不存在</span>
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {missingCwd}
                </span>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setMissingCwd(null)}
                  disabled={creatingDir || submitting}
                >
                  先不创建
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateMissingDirectory}
                  disabled={creatingDir || submitting}
                >
                  {creatingDir ? "创建中..." : "创建目录并继续"}
                </Button>
              </div>
            </section>
          ) : null}
          <section aria-label="会话模式" className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">会话模式</span>
              <span className="text-xs text-muted-foreground">
                {mode === "pty" ? "完整 CLI 终端" : "消息式对话"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={mode === "pty"}
                onClick={() => handleModeChange("pty")}
                className={cn(
                  "flex min-h-14 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  mode === "pty" ? "border-primary/70 bg-primary/10" : "border-border bg-muted/20",
                )}
              >
                <span className="text-sm font-medium">终端模式</span>
                <span className="text-xs text-muted-foreground">像本地 CLI 一样操作</span>
              </button>
              <button
                type="button"
                aria-pressed={mode === "json"}
                onClick={() => handleModeChange("json")}
                className={cn(
                  "flex min-h-14 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  mode === "json" ? "border-primary/70 bg-primary/10" : "border-border bg-muted/20",
                )}
              >
                <span className="text-sm font-medium">聊天模式</span>
                <span className="text-xs text-muted-foreground">按消息发送和显示</span>
              </button>
            </div>
          </section>
          <section aria-label="Agent CLI" className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">Agent CLI</span>
              <span className="text-xs text-muted-foreground">
                {mode === "pty" ? "选择本机 CLI" : "Codex 不可用"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={provider === "claude"}
                onClick={() => setProvider("claude")}
                className={cn(
                  "flex min-h-14 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  provider === "claude"
                    ? "border-primary/70 bg-primary/10"
                    : "border-border bg-muted/20",
                )}
              >
                <span className="text-sm font-medium">Claude Code</span>
                <span className="text-xs text-muted-foreground">可用</span>
              </button>
              <button
                type="button"
                aria-pressed={provider === "codex"}
                aria-disabled={mode === "json"}
                onClick={() => {
                  if (mode === "json") return;
                  setProvider("codex");
                }}
                className={cn(
                  "flex min-h-14 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  mode === "json" && "cursor-not-allowed opacity-45",
                  provider === "codex"
                    ? "border-primary/70 bg-primary/10"
                    : "border-border bg-muted/20",
                )}
              >
                <span className="text-sm font-medium">Codex</span>
                <span className="text-xs text-muted-foreground">
                  {mode === "pty" ? "可用" : "聊天模式暂不可用"}
                </span>
              </button>
            </div>
          </section>
          {mode === "json" ? (
            <label className="flex flex-col gap-2">
              <span className="text-sm">权限模式</span>
              <Select
                value={permissionMode}
                onValueChange={(value) => setPermissionMode(value as PermissionMode)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_MODE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
