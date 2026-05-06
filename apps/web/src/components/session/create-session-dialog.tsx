// 新建会话 Dialog, 字段: name (可选) / CWD
// Web 新建会话走 serve 托管 PTY，Claude/Codex 都由本机 proxy 持有真实 Agent CLI。
// CWD 行用共享 FilePathPicker (mode="select", dirsOnly) 浏览目录, 同步到文本输入
// 权限模式只对 JSON worker 有效；当前 PTY 创建路径不展示该控件，避免误导。
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
import { FilePathPicker } from "@/components/chat/file-path-picker";

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateSessionDialog({ open, onOpenChange }: CreateSessionDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [submitting, setSubmitting] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const cwdFieldRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const homePath = useFileStore((s) => s.homePath);
  const mode = "pty" as const;

  // 打开对话框时, 若 CWD 还没被用户改过, 用 homePath 作为默认起点
  useEffect(() => {
    if (open && !cwd && homePath) {
      setCwd(homePath);
    }
  }, [open, homePath, cwd]);

  // 只在提交态订阅 session_create_response，避免跨实例竞争
  // 卸载时强制清理订阅，防止对话框多次打开/关闭泄漏 handler
  useEffect(() => {
    if (!submitting) return;
    const relay = relayClientRef;
    if (!relay) return;

    const unsub = relay.onMessage((msg) => {
      const ctrl = msg as RelayControlMessage;
      if (ctrl.type !== "session_create_response") return;
      unsub();
      setSubmitting(false);

      if (ctrl.error || !ctrl.sessionId) {
        toast.error(`创建失败: ${ctrl.error ?? "unknown"}`);
        return;
      }

      const newSession: SessionInfo = {
        sessionId: ctrl.sessionId,
        name: name.trim() || undefined,
        state: "idle",
        mode: ctrl.mode ?? mode,
        provider: ctrl.provider ?? provider,
      };
      useSessionStore.getState().addSession(newSession);
      onOpenChange(false);
      setName("");
      setCwd("");
      setCwdPickerOpen(false);
      setProvider("claude");
      navigate(`/chat/${ctrl.sessionId}?mode=${ctrl.mode ?? mode}`);
    });

    return unsub;
  }, [submitting, name, mode, provider, navigate, onOpenChange]);

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
    setSubmitting(true);
    relay.sendControl({ type: "session_create", cwd: cwd.trim(), mode, provider });
  }

  function handleCwdFieldBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocus = event.relatedTarget;
    if (nextFocus instanceof Node && cwdFieldRef.current?.contains(nextFocus)) return;
    setCwdPickerOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-sm">名称（可选）</span>
            <input
              type="text"
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
          <section aria-label="Agent CLI" className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">Agent CLI</span>
              <span className="text-xs text-muted-foreground">托管 PTY</span>
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
                <span className="text-xs text-muted-foreground">PTY 会话</span>
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={provider === "codex"}
                    onClick={() => setProvider("codex")}
                    className={cn(
                      "flex min-h-14 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      provider === "codex"
                        ? "border-primary/70 bg-primary/10"
                        : "border-border bg-muted/20",
                    )}
                  >
                    <span className="text-sm font-medium">Codex</span>
                    <span className="text-xs text-muted-foreground">PTY 会话</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">由本机 proxy 启动真实 Codex CLI</TooltipContent>
              </Tooltip>
            </div>
          </section>
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
