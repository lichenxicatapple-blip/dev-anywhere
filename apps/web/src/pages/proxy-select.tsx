import { useAppStore } from "@/stores/app-store";

export function ProxySelectPage() {
  const { phase, connected, proxies, clientId, relayUrl } = useAppStore();

  return (
    <div className="flex flex-col h-screen bg-[var(--background)]">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
        <span className="text-sm font-medium text-[var(--foreground)]">
          ProxySelect (/)
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-2 text-sm text-[var(--foreground)]">
        <div>Phase: <span className="font-mono text-[var(--primary)]">{phase}</span></div>
        <div>Connected: <span className="font-mono">{String(connected)}</span></div>
        <div>Proxies: <span className="font-mono">{proxies.length}</span></div>
        <div>ClientId: <span className="font-mono text-[var(--muted-foreground)]">{clientId}</span></div>
        <div>RelayUrl: <span className="font-mono text-[var(--muted-foreground)]">{relayUrl || "(empty)"}</span></div>
      </div>
    </div>
  );
}
