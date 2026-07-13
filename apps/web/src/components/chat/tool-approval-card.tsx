import { useRef, useState, type ComponentType, type ReactNode } from "react";
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
import { getClaudeToolActivityDetails } from "@/lib/claude-activity-summary";
import { ActivityDetailView } from "./activity-detail-view";

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
  queuePosition?: number;
  queueSize?: number;
}

export function ToolApprovalCard({
  approval,
  sessionId,
  container,
  queuePosition,
  queueSize,
}: ToolApprovalCardProps) {
  const [acted, setActed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const transportReady = useAppStore((state) => state.connected && state.proxyOnline);
  const cardRef = useRef<HTMLDivElement>(null);

  const summary = summarizeToolInput(approval.toolName, approval.input);
  const previewDetails = getClaudeToolActivityDetails(approval.toolName, approval.input).filter(
    (item) => item.content.length,
  );
  const isResolved = approval.status !== "pending";
  const Icon = toolIcon(approval.toolName);
  const queueLabel =
    queueSize && queueSize > 1 && queuePosition ? `${queuePosition}/${queueSize}` : null;

  function renderContainer(content: ReactNode) {
    if (container === "floating") return content;
    return (
      <div data-slot="tool-approval-row" className="dev-message-rail mx-auto w-full min-w-0">
        {content}
      </div>
    );
  }

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
    return renderContainer(
      <div
        data-slot="tool-approval-card"
        data-status={approval.status}
        className={cn(
          "rounded-md border border-border bg-card px-3 py-2 text-xs",
          container === "inline" && "w-full min-w-0 max-w-full",
          container === "floating" && "fixed bottom-4 right-4 max-w-[360px] shadow-lg",
        )}
      >
        <span className={cn("font-mono", color)}>{approval.toolName}</span>
        <span className="text-muted-foreground ml-2">
          {approval.status === "approved" ? "已允许" : "已拒绝"}
        </span>
      </div>,
    );
  }

  return renderContainer(
    <div
      ref={cardRef}
      tabIndex={-1}
      data-slot="tool-approval-card"
      data-status="pending"
      className={cn(
        "rounded-md border border-border bg-card p-3 flex flex-col gap-3 ring-2 ring-[var(--color-status-warning)]/40",
        container === "inline" && "w-full min-w-0 max-w-full",
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
        className="flex min-h-11 min-w-0 items-center gap-2 rounded p-2 text-left -m-2 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0 md:p-1 md:-m-1"
      >
        <Icon className="size-4 shrink-0 text-[var(--color-status-warning)]" aria-hidden="true" />
        <span className="shrink-0 font-semibold text-sm">{approval.toolName}</span>
        {queueLabel && (
          <span
            className="shrink-0 rounded border border-[var(--color-status-warning)]/40 bg-[var(--color-status-warning)]/10 px-1.5 py-0.5 text-[10px] leading-none text-[var(--color-status-warning)]"
            aria-label={`第 ${queuePosition} 个审批，共 ${queueSize} 个`}
          >
            {queueLabel}
          </span>
        )}
        <span
          data-slot="tool-approval-summary"
          className="min-w-0 text-xs text-muted-foreground flex-1 truncate font-mono"
        >
          {summary.summary}
        </span>
        {expanded ? (
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
      </button>
      {expanded &&
        (previewDetails.length > 0 ? (
          <div
            data-slot="tool-approval-preview"
            className="min-w-0 space-y-2 border-t border-border pt-2 text-xs"
          >
            {previewDetails.map((item, index) => (
              <ActivityDetailView key={`${item.title}-${index}`} detail={item} />
            ))}
          </div>
        ) : (
          <pre
            data-slot="tool-approval-json"
            className="text-xs bg-muted rounded p-2 overflow-auto font-mono max-h-[50vh] whitespace-pre-wrap break-words"
          >
            {JSON.stringify(approval.input, null, 2)}
          </pre>
        ))}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-11 text-muted-foreground md:h-8"
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
            className="h-11 text-destructive hover:bg-destructive/10 hover:text-destructive md:h-8"
            disabled={acted || !transportReady}
            onClick={() => send("deny")}
            data-action="deny"
          >
            拒绝
          </Button>
          <Button
            size="sm"
            className="h-11 md:h-8"
            disabled={acted || !transportReady}
            onClick={() => send("allow")}
            data-action="allow"
          >
            允许
          </Button>
        </div>
      </div>
    </div>,
  );
}
