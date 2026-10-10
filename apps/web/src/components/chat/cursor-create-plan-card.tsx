import { useState } from "react";
import type { CursorAnswer, CursorPrompt } from "@dev-anywhere/shared";
import type { ToolApprovalRequest } from "@/stores/chat-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { toast } from "@/components/toast";
import { MarkdownView } from "./markdown-view";
import { cn } from "@/lib/utils";

interface CursorCreatePlanCardProps {
  approval: ToolApprovalRequest;
  sessionId: string;
}

function isCreatePlan(prompt: CursorPrompt | undefined): prompt is Extract<
  CursorPrompt,
  { type: "create_plan" }
> {
  return prompt?.type === "create_plan";
}

export function CursorCreatePlanCard({ approval, sessionId }: CursorCreatePlanCardProps) {
  const prompt = isCreatePlan(approval.cursorPrompt) ? approval.cursorPrompt : null;
  const [acted, setActed] = useState(false);
  const transportReady = useAppStore((state) => state.connected && state.proxyOnline);
  const isResolved = approval.status !== "pending";

  function send(answer: CursorAnswer): void {
    if (acted || isResolved) return;
    const relay = relayClientRef;
    if (!relay) return;
    if (!transportReady) {
      toast.warning("连接恢复后再审批");
      return;
    }
    const deny = answer.outcome !== "accepted";
    const sent = deny
      ? relay.sendControl({
          type: "tool_deny",
          sessionId,
          payload: { toolId: approval.requestId, cursorAnswer: answer },
        })
      : relay.sendControl({
          type: "tool_approve",
          sessionId,
          payload: { toolId: approval.requestId, cursorAnswer: answer },
        });
    if (!sent) {
      toast.warning("连接恢复后再审批");
      return;
    }
    setActed(true);
  }

  if (!prompt) return null;

  if (isResolved) {
    const color =
      approval.status === "approved" ? "text-[var(--color-status-success)]" : "text-destructive";
    return (
      <div
        data-slot="cursor-create-plan-card"
        data-status={approval.status}
        className="rounded-md border border-border bg-card px-3 py-2 text-xs"
      >
        <div className={cn("font-medium", color)}>
          {approval.status === "approved" ? "已接受计划" : "已拒绝计划"}
          {prompt.name ? `：${prompt.name}` : ""}
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="cursor-create-plan-card"
      className="rounded-md border border-border bg-card px-3 py-3 text-sm"
    >
      <div className="mb-1 font-medium">{prompt.name || "Cursor 计划"}</div>
      {prompt.overview ? (
        <div className="mb-2 text-xs text-muted-foreground">{prompt.overview}</div>
      ) : null}
      <div className="max-h-[50vh] overflow-auto rounded-md bg-muted/40 p-2">
        <MarkdownView text={prompt.plan} />
      </div>
      {prompt.todos?.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {prompt.todos.map((todo) => (
            <li key={todo.id}>
              {todo.status === "completed" ? "✓" : "○"} {todo.content}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-11 text-destructive hover:bg-destructive/10 hover:text-destructive md:h-8"
          disabled={acted || !transportReady}
          onClick={() => send({ type: "create_plan", outcome: "rejected" })}
        >
          拒绝
        </Button>
        <Button
          size="sm"
          className="h-11 md:h-8"
          disabled={acted || !transportReady}
          onClick={() => send({ type: "create_plan", outcome: "accepted" })}
        >
          接受计划
        </Button>
      </div>
    </div>
  );
}
