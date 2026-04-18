// 新建会话 Dialog, 字段: name (可选) / mode (JSON|PTY) / CWD
// CWD 行用共享 FilePathPicker (mode="select", dirsOnly) 浏览目录, 同步到文本输入
// 不包含 permission mode / resume —— CONTEXT D-30 移到 Chat 会话设置菜单
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { RelayControlMessage, SessionInfo } from "@cc-anywhere/shared";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useSessionStore } from "@/stores/session-store";
import { showErrorToast } from "@/components/toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FilePathPicker } from "@/components/chat/file-path-picker";

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateSessionDialog({ open, onOpenChange }: CreateSessionDialogProps) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"json" | "pty">("json");
  const [cwd, setCwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

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
        showErrorToast(`创建失败: ${ctrl.error ?? "unknown"}`);
        return;
      }

      const newSession: SessionInfo = {
        sessionId: ctrl.sessionId,
        name: name.trim() || undefined,
        state: "idle",
        mode,
      };
      useSessionStore.getState().addSession(newSession);
      useSessionStore.getState().setCurrentSession(ctrl.sessionId, mode);
      onOpenChange(false);
      setName("");
      setCwd("");
      navigate(`/chat/${ctrl.sessionId}?mode=${mode}`);
    });

    return unsub;
  }, [submitting, name, mode, navigate, onOpenChange]);

  function handleSubmit() {
    if (!cwd.trim()) {
      showErrorToast("请输入工作目录");
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      showErrorToast("Relay 客户端未就绪");
      return;
    }
    setSubmitting(true);
    relay.sendControl({ type: "session_create", cwd: cwd.trim() });
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
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm">模式</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                <input
                  type="radio"
                  name="mode"
                  value="json"
                  checked={mode === "json"}
                  onChange={() => setMode("json")}
                />
                JSON
              </label>
              <label className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                <input
                  type="radio"
                  name="mode"
                  value="pty"
                  checked={mode === "pty"}
                  onChange={() => setMode("pty")}
                />
                PTY
              </label>
            </div>
          </fieldset>
          <label className="flex flex-col gap-2">
            <span className="text-sm">工作目录</span>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="输入或选择绝对路径"
              className="h-9 px-3 rounded-md bg-input border border-border text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <FilePathPicker
              mode="select"
              dirsOnly
              filter={cwd}
              onSelect={(path) => setCwd(path)}
            />
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
