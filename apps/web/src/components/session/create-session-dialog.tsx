// 新建会话 Dialog, 字段: name (可选) / CWD
// Web 新建会话走 serve 托管 PTY，Claude/Codex 都由本机 proxy 持有真实 Agent CLI。
// CWD 行用共享 FilePathPicker (mode="select", dirsOnly) 浏览目录, 同步到文本输入
// 权限模式只对 JSON 消息流有效；当前 PTY 创建路径不展示该控件，避免误导。
import { type FocusEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { RelayControlMessage, SessionInfo } from "@dev-anywhere/shared";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

export function CreateSessionDialog({ open, onOpenChange }: CreateSessionDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [mode, setMode] = useState<SessionMode>("pty");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [submitting, setSubmitting] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const cwdFieldRef = useRef<HTMLDivElement>(null);
  const pendingCreateUnsubRef = useRef<(() => void) | null>(null);
  const navigate = useNavigate();
  const homePath = useFileStore((s) => s.homePath);

  // 打开对话框时, 若 CWD 还没被用户改过, 用 homePath 作为默认起点
  useEffect(() => {
    if (open && !cwd && homePath) {
      setCwd(homePath);
    }
  }, [open, homePath, cwd]);

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

  useEffect(() => {
    return () => {
      pendingCreateUnsubRef.current?.();
      pendingCreateUnsubRef.current = null;
    };
  }, []);

  function handleSubmit() {
    if (!cwd.trim()) {
      toast.error("请输入工作目录");
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      toast.error("Relay 客户端未就绪");
      return;
    }
    const submittedName = name.trim();
    const submittedMode = mode;
    const submittedProvider = provider;
    pendingCreateUnsubRef.current?.();
    setSubmitting(true);
    const unsub = relay.onMessage((msg) => {
      const ctrl = msg as RelayControlMessage;
      if (ctrl.type !== "session_create_response") return;
      unsub();
      if (pendingCreateUnsubRef.current === unsub) {
        pendingCreateUnsubRef.current = null;
      }
      setSubmitting(false);

      if (ctrl.error || !ctrl.sessionId) {
        toast.error(`创建失败: ${ctrl.error ?? "unknown"}`);
        return;
      }

      const newSession: SessionInfo = {
        sessionId: ctrl.sessionId,
        name: submittedName || undefined,
        state: "idle",
        mode: ctrl.mode ?? submittedMode,
        provider: ctrl.provider ?? submittedProvider,
      };
      useSessionStore.getState().addSession(newSession);
      onOpenChange(false);
      setName("");
      setCwd("");
      setCwdPickerOpen(false);
      setProvider("claude");
      setMode("pty");
      setPermissionMode("default");
      navigate(`/chat/${ctrl.sessionId}?mode=${ctrl.mode ?? submittedMode}`);
    });
    pendingCreateUnsubRef.current = unsub;
    relay.sendControl({
      type: "session_create",
      cwd: cwd.trim(),
      mode,
      provider,
      ...(mode === "json" ? { permissionMode } : {}),
    });
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
            className="flex flex-col gap-2"
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
              onChange={(e) => setCwd(e.target.value)}
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
                  setCwdPickerOpen(true);
                }}
              />
            ) : null}
          </div>
          <section aria-label="交互模式" className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">交互模式</span>
              <span className="text-xs text-muted-foreground">
                {mode === "pty" ? "完整终端" : "聊天消息"}
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
                <span className="text-sm font-medium">PTY</span>
                <span className="text-xs text-muted-foreground">像本地终端一样交互</span>
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
                <span className="text-sm font-medium">JSON</span>
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
              <Tooltip>
                <TooltipTrigger asChild>
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
                      {mode === "pty" ? "可用" : "暂不可用"}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {mode === "pty" ? "由本机 proxy 启动真实 Codex CLI" : "Codex 当前只支持 PTY 会话"}
                </TooltipContent>
              </Tooltip>
            </div>
          </section>
          {mode === "json" ? (
            <label className="flex flex-col gap-1">
              <span className="text-sm">权限模式</span>
              <Select
                value={permissionMode}
                onValueChange={(value) => setPermissionMode(value as PermissionMode)}
              >
                <SelectTrigger>
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
