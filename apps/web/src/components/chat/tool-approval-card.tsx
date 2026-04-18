// 工具审批卡, 紧凑态三按钮 + 详情展开 + 会话白名单记忆
// y/n/a 快捷键仅在卡片聚焦时响应, 防止污染全局输入
// 发送审批结果走 MessageEnvelope tool_approve / tool_deny (见 packages/shared/src/schemas/tool.ts):
//   relayClientRef.sendEnvelope({
//     seq, sessionId, timestamp, source: "client", version,
//     type: "tool_approve", payload: { toolId, whitelistTool? }
//   })
//   或 type: "tool_deny", payload: { toolId, reason? }
// 注意: 这些是 envelope 不是 RelayControl, sendEnvelope 而非 sendControl.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ToolApprovalRequest } from "@/stores/chat-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { Button } from "@/components/ui/button";
import { summarizeToolInput } from "@/utils/summarize-tool-input";
import { cn } from "@/lib/utils";

interface ToolApprovalCardProps {
  approval: ToolApprovalRequest;
  sessionId: string;
  container: "inline" | "floating";
}

function whitelistKey(sessionId: string): string {
  return `cc_toolWhitelist:${sessionId}`;
}

function readWhitelist(sessionId: string): string[] {
  try {
    const raw = localStorage.getItem(whitelistKey(sessionId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function addToWhitelist(sessionId: string, toolName: string): void {
  const current = readWhitelist(sessionId);
  if (current.includes(toolName)) return;
  localStorage.setItem(
    whitelistKey(sessionId),
    JSON.stringify([...current, toolName]),
  );
}

// 构造一个满足 MessageEnvelope BaseEnvelopeFields 的工具函数, 由本组件消费
function buildEnvelopeBase(sessionId: string) {
  return {
    seq: 0,
    sessionId,
    timestamp: Date.now(),
    source: "client" as const,
    version: "1",
  };
}

export function ToolApprovalCard({
  approval,
  sessionId,
  container,
}: ToolApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [acted, setActed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const summary = summarizeToolInput(approval.toolName, approval.input);
  const isResolved = approval.status !== "pending";

  function send(decision: "allow" | "deny", whitelistTool = false) {
    if (acted || isResolved) return;
    setActed(true);
    const relay = relayClientRef;
    if (!relay) return;
    const base = buildEnvelopeBase(sessionId);
    if (decision === "allow") {
      relay.sendEnvelope({
        ...base,
        type: "tool_approve",
        payload: { toolId: approval.requestId, whitelistTool },
      });
      if (whitelistTool) addToWhitelist(sessionId, approval.toolName);
    } else {
      relay.sendEnvelope({
        ...base,
        type: "tool_deny",
        payload: { toolId: approval.requestId },
      });
    }
  }

  // 键盘快捷键: y=allow, n=deny, a=always; 仅卡片内元素聚焦时响应
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (!card.contains(document.activeElement)) return;
      if (acted || isResolved) return;
      const key = e.key.toLowerCase();
      if (key === "y") {
        e.preventDefault();
        send("allow");
      } else if (key === "n") {
        e.preventDefault();
        send("deny");
      } else if (key === "a") {
        e.preventDefault();
        send("allow", true);
      }
    };
    card.addEventListener("keydown", onKey);
    return () => card.removeEventListener("keydown", onKey);
    // send 闭包依赖 acted/isResolved, approval 变化时也应重绑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acted, isResolved, approval.requestId]);

  if (isResolved) {
    const color =
      approval.status === "approved"
        ? "text-[var(--color-status-success)]"
        : "text-destructive";
    return (
      <div
        data-slot="tool-approval-card"
        data-status={approval.status}
        className={cn(
          "rounded-md border border-border bg-card px-3 py-2 text-xs",
          container === "floating" &&
            "fixed bottom-4 right-4 max-w-[360px] shadow-lg",
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
        "rounded-md border border-border bg-card p-3 flex flex-col gap-2",
        container === "floating" &&
          "fixed bottom-4 right-4 w-[360px] max-w-[90vw] shadow-lg z-20",
      )}
      role="region"
      aria-label={`工具审批: ${approval.toolName}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-[var(--color-status-warning)]">
          {approval.toolName}
        </span>
        <span className="text-xs text-muted-foreground flex-1 truncate">
          {summary.summary}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "收起详情" : "展开详情"}
        >
          {expanded ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
        </Button>
      </div>
      {expanded && (
        <pre className="text-xs bg-muted rounded p-2 overflow-x-auto font-mono max-h-48">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      )}
      <div className="flex gap-2 justify-end">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => send("deny")}
          data-action="deny"
        >
          拒绝
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => send("allow", true)}
          data-action="always"
        >
          总是允许此工具
        </Button>
        <Button size="sm" onClick={() => send("allow")} data-action="allow">
          允许
        </Button>
      </div>
      <div className="text-[10px] text-muted-foreground">
        快捷键: y=允许 / n=拒绝 / a=总是允许 (卡片聚焦时)
      </div>
    </div>
  );
}
