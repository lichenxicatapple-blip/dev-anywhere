import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";

export function SessionListPage() {
  const { phase, connected, selectedProxyId, selectedProxyName, proxyOnline } = useAppStore();
  const { sessions, currentSessionId } = useSessionStore();

  return (
    <div className="flex flex-col h-screen bg-[var(--background)]">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
        <span className="text-sm font-medium text-[var(--foreground)]">
          SessionList (/sessions)
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-2 text-sm text-[var(--foreground)]">
        <div>Phase: <span className="font-mono text-[var(--primary)]">{phase}</span></div>
        <div>Connected: <span className="font-mono">{String(connected)}</span></div>
        <div>ProxyId: <span className="font-mono">{selectedProxyId ?? "(none)"}</span></div>
        <div>ProxyName: <span className="font-mono">{selectedProxyName ?? "(none)"}</span></div>
        <div>ProxyOnline: <span className="font-mono">{String(proxyOnline)}</span></div>
        <div>Sessions: <span className="font-mono">{sessions.length}</span></div>
        <div>CurrentSessionId: <span className="font-mono">{currentSessionId ?? "(none)"}</span></div>
      </div>
    </div>
  );
}
