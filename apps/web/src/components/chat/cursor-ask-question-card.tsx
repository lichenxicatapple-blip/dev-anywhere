import { useMemo, useState } from "react";
import type { CursorAnswer, CursorPrompt } from "@dev-anywhere/shared";
import type { ToolApprovalRequest } from "@/stores/chat-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";

interface CursorAskQuestionCardProps {
  approval: ToolApprovalRequest;
  sessionId: string;
}

function isAskQuestion(prompt: CursorPrompt | undefined): prompt is Extract<
  CursorPrompt,
  { type: "ask_question" }
> {
  return prompt?.type === "ask_question";
}

export function CursorAskQuestionCard({ approval, sessionId }: CursorAskQuestionCardProps) {
  const prompt = isAskQuestion(approval.cursorPrompt) ? approval.cursorPrompt : null;
  const [acted, setActed] = useState(false);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const transportReady = useAppStore((state) => state.connected && state.proxyOnline);
  const isResolved = approval.status !== "pending";

  const canSubmit = useMemo(() => {
    if (!prompt) return false;
    return prompt.questions.every((question) => (selected[question.id] ?? []).length > 0);
  }, [prompt, selected]);

  function toggle(questionId: string, optionId: string, allowMultiple: boolean): void {
    setSelected((current) => {
      const existing = current[questionId] ?? [];
      if (allowMultiple) {
        return {
          ...current,
          [questionId]: existing.includes(optionId)
            ? existing.filter((id) => id !== optionId)
            : [...existing, optionId],
        };
      }
      return { ...current, [questionId]: [optionId] };
    });
  }

  function send(answer: CursorAnswer): void {
    if (acted || isResolved) return;
    const relay = relayClientRef;
    if (!relay) return;
    if (!transportReady) {
      toast.warning("连接恢复后再回答");
      return;
    }
    const deny = answer.outcome === "skipped" || answer.outcome === "cancelled";
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
      toast.warning("连接恢复后再回答");
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
        data-slot="cursor-ask-question-card"
        data-status={approval.status}
        className="rounded-md border border-border bg-card px-3 py-2 text-xs"
      >
        <div className={cn("font-medium", color)}>
          {approval.status === "approved" ? "已回答" : "已跳过"}：{prompt.title || "Cursor 提问"}
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="cursor-ask-question-card"
      className="rounded-md border border-border bg-card px-3 py-3 text-sm"
    >
      <div className="mb-3 font-medium">{prompt.title || "Cursor 需要你选择"}</div>
      <div className="space-y-4">
        {prompt.questions.map((question) => {
          const chosen = selected[question.id] ?? [];
          return (
            <div key={question.id} className="space-y-2">
              <div className="text-xs text-muted-foreground">{question.prompt}</div>
              <div className="flex flex-wrap gap-2">
                {question.options.map((option) => {
                  const active = chosen.includes(option.id);
                  return (
                    <Button
                      key={option.id}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      className="h-11 md:h-8"
                      disabled={acted || !transportReady}
                      onClick={() => toggle(question.id, option.id, question.allowMultiple === true)}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-11 text-muted-foreground md:h-8"
          disabled={acted || !transportReady}
          onClick={() => send({ type: "ask_question", outcome: "skipped" })}
        >
          跳过
        </Button>
        <Button
          size="sm"
          className="h-11 md:h-8"
          disabled={acted || !transportReady || !canSubmit}
          onClick={() =>
            send({
              type: "ask_question",
              outcome: "answered",
              answers: prompt.questions.map((question) => ({
                questionId: question.id,
                selectedOptionIds: selected[question.id] ?? [],
              })),
            })
          }
        >
          提交
        </Button>
      </div>
    </div>
  );
}
