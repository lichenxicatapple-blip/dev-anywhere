import { useRef, useState, type ComponentType } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  FilePen,
  Globe,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ToolApprovalRequest } from "@/stores/chat-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { Button } from "@/components/ui/button";
import { summarizeToolInput } from "@/utils/summarize-tool-input";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { toast } from "@/components/toast";

// 工具名到图标的映射, 未知工具兜底 Wrench
const TOOL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Write: FilePen,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Read: Eye,
  NotebookRead: Eye,
  Bash: Terminal,
  BashOutput: Terminal,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
};

function toolIcon(toolName: string): ComponentType<{ className?: string }> {
  return TOOL_ICONS[toolName] ?? Wrench;
}

interface ToolApprovalCardProps {
  approval: ToolApprovalRequest;
  sessionId: string;
  container: "inline" | "floating";
}

export function ToolApprovalCard({ approval, sessionId, container }: ToolApprovalCardProps) {
  const [acted, setActed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const transportReady = useAppStore((state) => state.connected && state.proxyOnline);
  const cardRef = useRef<HTMLDivElement>(null);

  const summary = summarizeToolInput(approval.toolName, approval.input);
  const isResolved = approval.status !== "pending";
  const Icon = toolIcon(approval.toolName);

  function send(decision: "allow" | "deny", whitelistTool = false) {
    if (acted || isResolved) return;
    const relay = relayClientRef;
    if (!relay) return;
    if (!transportReady) {
      toast.warning("连接恢复后再审批");
      return;
    }
    const sent =
      decision === "allow"
        ? relay.sendControl({
            type: "tool_approve",
            sessionId,
            payload: { toolId: approval.requestId, whitelistTool },
          })
        : relay.sendControl({
            type: "tool_deny",
            sessionId,
            payload: { toolId: approval.requestId },
          });
    if (!sent) {
      toast.warning("连接恢复后再审批");
      return;
    }
    setActed(true);
    // 状态由 proxy 的 permission_decision_result 回写，避免 UI 本地假定 provider/worker 已收到决策。
  }

  if (isResolved) {
    const color =
      approval.status === "approved" ? "text-[var(--color-status-success)]" : "text-destructive";
    return (
      <div
        data-slot="tool-approval-card"
        data-status={approval.status}
        className={cn(
          "rounded-md border border-border bg-card px-3 py-2 text-xs",
          container === "floating" && "fixed bottom-4 right-4 max-w-[360px] shadow-lg",
        )}
      >
        <span className={cn("font-mono", color)}>{approval.toolName}</span>
        <span className="text-muted-foreground ml-2">
          {approval.status === "approved" ? "已允许" : "已拒绝"}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-slot="tool-approval-card"
      data-status="pending"
      className={cn(
        "rounded-md border border-border bg-card p-3 flex flex-col gap-3 ring-2 ring-ring/40",
        container === "floating" && "fixed bottom-4 right-4 w-[360px] max-w-[90vw] shadow-lg z-20",
      )}
      role="region"
      aria-label={`工具审批: ${approval.toolName}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? "收起详情" : "展开详情"}
        className="flex items-center gap-2 min-w-0 text-left -m-1 p-1 rounded hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className="size-4 shrink-0 text-[var(--color-status-warning)]" aria-hidden="true" />
        <span className="font-semibold text-sm">{approval.toolName}</span>
        <span className="text-xs text-muted-foreground flex-1 truncate font-mono">
          {summary.summary}
        </span>
        {expanded ? (
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
      </button>
      {expanded && (
        <pre className="text-xs bg-muted rounded p-2 overflow-auto font-mono max-h-[50vh] whitespace-pre-wrap break-words">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={acted || !transportReady}
          onClick={() => send("allow", true)}
          data-action="always"
        >
          始终允许
        </Button>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            disabled={acted || !transportReady}
            onClick={() => send("deny")}
            data-action="deny"
          >
            拒绝
          </Button>
          <Button
            size="sm"
            disabled={acted || !transportReady}
            onClick={() => send("allow")}
            data-action="allow"
          >
            允许
          </Button>
        </div>
      </div>
    </div>
  );
}
