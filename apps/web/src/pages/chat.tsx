import { useParams, useSearchParams } from "react-router";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { useChatStore } from "@/stores/chat-store";

export function ChatPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const mode = searchParams.get("mode");

  const { phase, connected, proxyOnline } = useAppStore();
  const { currentSessionId } = useSessionStore();
  const { messages, isWorking, workingToolName, pendingApprovals } = useChatStore();

  return (
    <div className="flex flex-col h-screen bg-[var(--background)]">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
        <span className="text-sm font-medium text-[var(--foreground)]">
          Chat (/chat/:id)
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-2 text-sm text-[var(--foreground)]">
        <div>Params.id: <span className="font-mono text-[var(--primary)]">{id ?? "(none)"}</span></div>
        <div>SearchParams.mode: <span className="font-mono">{mode ?? "(none)"}</span></div>
        <div>Phase: <span className="font-mono text-[var(--primary)]">{phase}</span></div>
        <div>Connected: <span className="font-mono">{String(connected)}</span></div>
        <div>ProxyOnline: <span className="font-mono">{String(proxyOnline)}</span></div>
        <div>CurrentSessionId: <span className="font-mono">{currentSessionId ?? "(none)"}</span></div>
        <div>Messages: <span className="font-mono">{messages.length}</span></div>
        <div>IsWorking: <span className="font-mono">{String(isWorking)}</span></div>
        <div>WorkingToolName: <span className="font-mono">{workingToolName || "(none)"}</span></div>
        <div>PendingApprovals: <span className="font-mono">{pendingApprovals.length}</span></div>
      </div>
    </div>
  );
}
