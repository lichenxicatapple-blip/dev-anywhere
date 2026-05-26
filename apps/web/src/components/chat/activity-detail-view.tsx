import { useMemo } from "react";
import {
  isDiffActivityDetail,
  type ChatActivityDetail,
  type ChatActivityDiffDetail,
} from "@/lib/chat-activity-detail";
import { cn } from "@/lib/utils";
import { buildUnifiedTextDiff, type UnifiedTextDiffRow } from "@/lib/unified-text-diff";

interface ActivityDetailViewProps {
  detail: ChatActivityDetail;
}

function lineNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

function rowPrefix(type: UnifiedTextDiffRow["type"]): string {
  if (type === "add") return "+";
  if (type === "remove") return "-";
  return " ";
}

function rowClass(type: UnifiedTextDiffRow["type"]): string {
  if (type === "add") {
    return "border-l-[3px] border-l-emerald-500/60 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100";
  }
  if (type === "remove") {
    return "border-l-[3px] border-l-red-500/60 bg-red-500/10 text-red-950 dark:text-red-100";
  }
  return "border-l-[3px] border-l-transparent text-foreground";
}

function UnifiedDiffDetail({ detail }: { detail: ChatActivityDiffDetail }) {
  const rows = useMemo(
    () => buildUnifiedTextDiff(detail.oldContent, detail.newContent),
    [detail.oldContent, detail.newContent],
  );
  const removedCount = rows.filter((row) => row.type === "remove").length;
  const addedCount = rows.filter((row) => row.type === "add").length;

  return (
    <section data-slot="activity-detail" data-kind="diff" className="min-w-0">
      <div className="mb-1 flex min-w-0 items-center gap-2 text-[11px] leading-none text-current/70">
        <span className="min-w-0 truncate">{detail.title}</span>
        <span
          data-slot="activity-diff-stat"
          className="shrink-0 font-mono text-[10px] text-red-600 dark:text-red-300/90"
        >
          -{removedCount}
        </span>
        <span
          data-slot="activity-diff-stat"
          className="shrink-0 font-mono text-[10px] text-emerald-600 dark:text-emerald-300/90"
        >
          +{addedCount}
        </span>
      </div>
      <div
        data-slot="activity-diff-content"
        className="max-h-[min(58vh,560px)] min-w-0 overflow-auto rounded border border-current/10 bg-background/90 font-mono text-[11px] leading-relaxed text-foreground"
      >
        <div className="sticky top-0 z-10 grid w-full grid-cols-[2.75rem_2.75rem_1.25rem_minmax(0,1fr)] border-b border-border bg-muted/80 px-0 text-[10px] text-muted-foreground backdrop-blur">
          <span className="px-2 py-1 text-right">旧</span>
          <span className="px-2 py-1 text-right">新</span>
          <span className="px-1 py-1" aria-hidden="true" />
          <span className="px-2 py-1">内容</span>
        </div>
        {rows.length > 0 ? (
          rows.map((row, index) => (
            <div
              key={`${row.type}-${row.oldLineNumber ?? ""}-${row.newLineNumber ?? ""}-${index}`}
              data-slot="activity-diff-row"
              data-kind={row.type}
              className={cn(
                "grid w-full grid-cols-[2.75rem_2.75rem_1.25rem_minmax(0,1fr)]",
                rowClass(row.type),
              )}
            >
              <span className="select-none border-r border-current/10 px-2 text-right tabular-nums text-current/45">
                {lineNumber(row.oldLineNumber)}
              </span>
              <span className="select-none border-r border-current/10 px-2 text-right tabular-nums text-current/45">
                {lineNumber(row.newLineNumber)}
              </span>
              <span
                data-slot="activity-diff-prefix"
                className="select-none px-1 text-center text-current/70"
                aria-hidden="true"
              >
                {rowPrefix(row.type)}
              </span>
              <code className="min-w-0 whitespace-pre-wrap break-words px-2">
                {row.text || " "}
              </code>
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-muted-foreground">没有文本变更</div>
        )}
      </div>
    </section>
  );
}

export function ActivityDetailView({ detail }: ActivityDetailViewProps) {
  if (isDiffActivityDetail(detail)) {
    return <UnifiedDiffDetail detail={detail} />;
  }

  return (
    <section data-slot="activity-detail" data-kind="text" className="min-w-0">
      <div className="mb-1 text-[11px] leading-none text-current/70">{detail.title}</div>
      <pre
        data-slot="activity-detail-content"
        className="max-h-[min(55vh,520px)] overflow-auto rounded border border-current/10 bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words"
      >
        {detail.content}
      </pre>
    </section>
  );
}
