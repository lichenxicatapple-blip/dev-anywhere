// layout=page 用于移动端/空壳页，选中后进入 /sessions。
// layout=dropdown 用于桌面侧栏顶部，只切换当前绑定的开发机 proxy。
import { useState } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, Check, Loader2 } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { EmptyState } from "@/components/shell/empty-state";
import { cn } from "@/lib/utils";
import { ProxyStatusDot } from "./proxy-status-dot";

interface ProxySwitcherProps {
  layout: "page" | "dropdown";
  variant?: "default" | "sidebarChrome";
}

export function ProxySwitcher({ layout, variant = "default" }: ProxySwitcherProps) {
  const proxies = useAppStore((s) => s.proxies);
  const proxyListLoaded = useAppStore((s) => s.proxyListLoaded);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);

  async function handleSelect(proxyId: string, proxyName: string | undefined): Promise<void> {
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const displayName = proxyName ?? proxyId;
    const result = await relay.selectProxy(proxyId);
    if (!result.success) {
      toast.error(`无法连接 ${displayName}：${result.error ?? "未知错误"}`);
      return;
    }
    localStorage.setItem("cc_proxyId", proxyId);
    useAppStore.getState().setProxy(proxyId, proxyName ?? null);
    useAppStore.getState().setProxyOnline(true);
    useAppStore.getState().transitionToPhase("session_browsing");
    // 绑定成功后刷新会话列表，并用 request-scoped snapshot 拉取历史和 provider 状态。
    relay.sendControl({ type: "session_list" });
    void relay
      .requestAgentStatuses()
      .then((statuses) => {
        const store = useSessionStore.getState();
        for (const status of statuses) {
          store.setAgentStatus(status.sessionId, status.payload);
        }
      })
      .catch(() => undefined);
    void relay
      .requestSessionHistory()
      .then((sessions) => useSessionStore.getState().setHistorySessions(sessions))
      .catch(() => undefined);
    setDropdownOpen(false);
    if (layout === "page") {
      navigate("/sessions");
    }
  }

  if (layout === "page") {
    // 冷启动/重连期间 WS 未回 proxy_list_response 前, proxies=[] 但不是"真的没有", 显示加载态避免空态一闪而过
    if (!proxyListLoaded) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground animate-in fade-in-0 duration-200 motion-reduce:animate-none">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          <p className="text-sm">连接中...</p>
        </div>
      );
    }
    if (proxies.length === 0) {
      return <EmptyState variant="no-proxy" />;
    }
    return (
      <div className="flex flex-col gap-3 p-4 h-full overflow-auto">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          可连接开发机
        </h3>
        <ul role="list" className="flex flex-col gap-2">
          {proxies.map((p) => (
            <li key={p.proxyId}>
              <button
                type="button"
                data-slot="proxy-item"
                data-proxy-id={p.proxyId}
                data-online={p.online}
                disabled={!p.online}
                onClick={() => handleSelect(p.proxyId, p.name)}
                className="w-full flex items-center gap-3 px-3 h-11 min-h-[44px] rounded-md border border-border bg-card hover:bg-accent transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-card"
                aria-pressed={selectedProxyId === p.proxyId}
                title={!p.online ? "这台开发机离线，暂时无法连接" : undefined}
              >
                <ProxyStatusDot status={p.online ? "online" : "offline"} />
                <span className="text-sm font-normal flex-1 truncate min-w-0">
                  {p.name ?? p.proxyId}
                </span>
                {selectedProxyId === p.proxyId && (
                  <Check className="h-4 w-4 text-primary shrink-0" aria-label="已选" />
                )}
                {!p.online && <span className="text-xs text-muted-foreground shrink-0">离线</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // layout === "dropdown": desktop sidebar proxy selector.
  const currentProxy = proxies.find((p) => p.proxyId === selectedProxyId);
  const currentProxyName = currentProxy?.name ?? currentProxy?.proxyId ?? "未选择开发机";
  return (
    <Popover open={dropdownOpen} onOpenChange={setDropdownOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="proxy-switcher-trigger"
          className={cn(
            "group transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            variant === "sidebarChrome"
              ? "inline-flex min-h-9 min-w-0 max-w-full items-center justify-start gap-1.5 rounded-md text-left text-foreground hover:text-primary"
              : "flex h-10 w-full items-center gap-2 rounded-md border border-border bg-background px-4 hover:bg-accent",
          )}
          aria-label={`当前连接：${currentProxyName}`}
        >
          {variant === "default" && <span className="h-4 w-4 shrink-0" aria-hidden />}
          <span
            className={cn(
              "truncate",
              variant === "sidebarChrome"
                ? "min-w-0 text-base font-semibold leading-none"
                : "flex-1 text-center text-sm font-normal",
            )}
          >
            {currentProxyName}
          </span>
          <ChevronDown
            className="h-4 w-4 text-muted-foreground shrink-0 transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-1">
        {proxies.length === 0 ? (
          <div className="text-xs text-muted-foreground p-2">暂无可连接开发机</div>
        ) : (
          <ul role="list" className="flex flex-col">
            {proxies.map((p) => (
              <li key={p.proxyId}>
                <button
                  type="button"
                  data-slot="proxy-item"
                  data-proxy-id={p.proxyId}
                  data-online={p.online}
                  disabled={!p.online}
                  onClick={() => handleSelect(p.proxyId, p.name)}
                  className="w-full flex items-center gap-2 px-2 h-9 rounded-md hover:bg-accent transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-pressed={selectedProxyId === p.proxyId}
                  title={!p.online ? "这台开发机离线" : undefined}
                >
                  <ProxyStatusDot status={p.online ? "online" : "offline"} />
                  <span className="text-sm font-normal flex-1 truncate min-w-0">
                    {p.name ?? p.proxyId}
                  </span>
                  {selectedProxyId === p.proxyId && (
                    <Check className="h-4 w-4 text-primary shrink-0" aria-label="已选" />
                  )}
                  {!p.online && selectedProxyId !== p.proxyId && (
                    <span className="text-xs text-muted-foreground shrink-0">离线</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
