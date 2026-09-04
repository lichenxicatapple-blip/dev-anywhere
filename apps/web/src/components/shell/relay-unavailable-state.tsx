import { Loader2 } from "lucide-react";
import type { RelayConnectionIssue } from "@/stores/app-store";

export function RelayUnavailableState({ issue }: { issue: RelayConnectionIssue }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground"
      data-slot="relay-connection-state"
      data-state="unavailable"
      role="status"
      aria-live="polite"
    >
      {issue === "unreachable" ? (
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      ) : null}
      <p className="text-sm">{issue === "unreachable" ? "暂时无法连接" : "连接已断开"}</p>
    </div>
  );
}
