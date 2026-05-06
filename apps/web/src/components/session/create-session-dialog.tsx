// 新建会话 Dialog, 字段: name (可选) / CWD
// 目前只能创建 Claude JSON 会话; 托管 PTY 专项会接入 Claude/Codex PTY 创建。
// CWD 行用共享 FilePathPicker (mode="select", dirsOnly) 浏览目录, 同步到文本输入
// Permission mode lives here for new sessions; resume remains a chat-level action.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { RelayControlMessage, SessionInfo } from "@dev-anywhere/shared";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useSessionStore } from "@/stores/session-store";
import { useFileStore } from "@/stores/file-store";
import { toast } from "@/components/toast";
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

type PermissionMode = "default" | "auto" | "acceptEdits" | "plan" | "bypassPermissions";

const PERMISSION_MODE_OPTIONS: {
  value: PermissionMode;
  label: string;
  hint: string;
  danger?: boolean;
}[] = [
  { value: "default", label: "严格审批", hint: "每个工具调用都弹审批（推荐）" },
  { value: "auto", label: "自动判定", hint: "Claude 内置规则决定是否放行" },
  { value: "acceptEdits", label: "自动接受编辑", hint: "文件编辑直接放行，其他仍审批" },
  { value: "plan", label: "只读规划", hint: "只做只读操作，不执行 side-effect 工具" },
  {
    value: "bypassPermissions",
    label: "跳过全部审批（危险）",
    hint: "所有工具直接放行，仅限可信会话",
    danger: true,
  },
];

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateSessionDialog({ open, onOpenChange }: CreateSessionDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const homePath = useFileStore((s) => s.homePath);
  const mode = "json" as const;
  const provider = "claude" as const;
  const currentPermissionOption = PERMISSION_MODE_OPTIONS.find((o) => o.value === permissionMode);

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
        mode,
        provider,
      };
      useSessionStore.getState().addSession(newSession);
      onOpenChange(false);
      setName("");
      setCwd("");
      setPermissionMode("default");
      navigate(`/chat/${ctrl.sessionId}?mode=${mode}`);
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
    relay.sendControl({ type: "session_create", cwd: cwd.trim(), provider, permissionMode });
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
          <div className="flex flex-col gap-2">
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
            <FilePathPicker
              mode="select"
              dirsOnly
              filter={cwd}
              title="选择下一级目录"
              onSelect={(path) => setCwd(path)}
            />
          </div>
          <section aria-label="Agent CLI" className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">Agent CLI</span>
              <span className="text-xs text-muted-foreground">默认使用 Claude Code</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed="true"
                className="flex min-h-14 flex-col items-start justify-center gap-1 rounded-md border border-primary/70 bg-primary/10 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-sm font-medium">Claude Code</span>
                <span className="text-xs text-muted-foreground">JSON 会话</span>
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-disabled="true"
                    onClick={(e) => e.preventDefault()}
                    className="flex min-h-14 cursor-not-allowed flex-col items-start justify-center gap-1 rounded-md border border-border bg-muted/20 px-3 text-left opacity-55 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="text-sm font-medium">Codex</span>
                    <span className="text-xs text-muted-foreground">即将支持</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Codex 网页创建会在托管 PTY 专项中接入</TooltipContent>
              </Tooltip>
            </div>
          </section>
          <label className="flex flex-col gap-1">
            <span className="text-sm">权限模式</span>
            <Select
              value={permissionMode}
              onValueChange={(v) => setPermissionMode(v as PermissionMode)}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_MODE_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    className={opt.danger ? "text-destructive focus:text-destructive" : undefined}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span
              className={`text-xs ${currentPermissionOption?.danger ? "text-destructive" : "text-muted-foreground"}`}
            >
              {currentPermissionOption?.hint}
            </span>
          </label>
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
