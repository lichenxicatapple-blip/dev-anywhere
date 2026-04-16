import { useAppStore } from "@/stores/app-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { router } from "@/lib/router";

export function ProxySelectPage() {
  const { phase, connected, proxies, clientId, relayUrl } = useAppStore();

  async function handleSelect(proxyId: string, proxyName: string | undefined) {
    if (!relayClientRef) return;
    const result = await relayClientRef.selectProxy(proxyId);
    if (result.success) {
      localStorage.setItem("cc_proxyId", proxyId);
      useAppStore.getState().setProxy(proxyId, proxyName || null);
      useAppStore.getState().setProxyOnline(true);
      useAppStore.getState().transitionToPhase("session_browsing");
      router.navigate("/sessions");
    }
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--background)]">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
        <span className="text-sm font-medium text-[var(--foreground)]">
          ProxySelect (/)
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4 text-sm text-[var(--foreground)]">
        <div className="space-y-2">
          <div>Phase: <span className="font-mono text-[var(--primary)]">{phase}</span></div>
          <div>Connected: <span className="font-mono">{String(connected)}</span></div>
          <div>ClientId: <span className="font-mono text-[var(--muted-foreground)]">{clientId}</span></div>
          <div>RelayUrl: <span className="font-mono text-[var(--muted-foreground)]">{relayUrl || "(empty)"}</span></div>
        </div>
        <div className="space-y-2">
          <div className="font-medium">Proxies ({proxies.length})</div>
          {proxies.length === 0 && <div className="text-[var(--muted-foreground)]">No proxies available</div>}
          {proxies.map((p) => (
            <button
              key={p.proxyId}
              onClick={() => handleSelect(p.proxyId, p.name)}
              className="block w-full text-left px-3 py-2 rounded bg-[var(--card)] border border-[var(--border)] hover:border-[var(--primary)] transition-colors"
            >
              <span className="font-mono">{p.name || p.proxyId}</span>
              <span className={`ml-2 text-xs ${p.online ? "text-[var(--success)]" : "text-[var(--muted-foreground)]"}`}>
                {p.online ? "online" : "offline"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
