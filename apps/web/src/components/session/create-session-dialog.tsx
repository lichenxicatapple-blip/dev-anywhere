// 新建会话 Dialog, 字段: name (可选) / CWD
// 只能创建 JSON 会话; PTY 需要本地真实终端宿主, Web 无法远程创建
// CWD 行用共享 FilePathPicker (mode="select", dirsOnly) 浏览目录, 同步到文本输入
// 不包含 permission mode / resume —— CONTEXT D-30 移到 Chat 会话设置菜单
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { RelayControlMessage, SessionInfo } from "@cc-anywhere/shared";
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
      };
      useSessionStore.getState().addSession(newSession);
      onOpenChange(false);
      setName("");
      setCwd("");
      setPermissionMode("default");
      navigate(`/chat/${ctrl.sessionId}?mode=${mode}`);
    });

    return unsub;
  }, [submitting, name, mode, navigate, onOpenChange]);

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
    relay.sendControl({ type: "session_create", cwd: cwd.trim(), permissionMode });
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
          <label className="flex flex-col gap-2">
            <span className="text-sm">工作目录</span>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="输入或选择绝对路径"
              className="h-9 px-3 rounded-md bg-input border border-border text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <FilePathPicker mode="select" dirsOnly filter={cwd} onSelect={(path) => setCwd(path)} />
          </label>
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
