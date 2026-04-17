// ProxySwitcher dual-layout 组件, Plan 10-02 正式实现, 覆盖 10-01b stub
// layout=page: 移动端全屏列表, 选中后 navigate 到 /sessions
// layout=dropdown: 桌面侧栏顶部 Popover, 选中后不跳路由, 仅更新 app-store
//
// sidebar.tsx 已在 10-01b 通过 import 绑定本模块路径, 本 Plan 只替换 body
// 新增 export 或改 props 签名会破坏 sidebar.tsx 与 10-03 并行, 禁止
import { useNavigate } from "react-router";
import { useAppStore } from "@/stores/app-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { showErrorToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { EmptyState } from "@/components/shell/empty-state";
import { ProxyStatusDot } from "./proxy-status-dot";

interface ProxySwitcherProps {
  layout: "page" | "dropdown";
}

export function ProxySwitcher({ layout }: ProxySwitcherProps) {
  const proxies = useAppStore((s) => s.proxies);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const navigate = useNavigate();

  async function handleSelect(
    proxyId: string,
    proxyName: string | undefined,
  ): Promise<void> {
    const relay = relayClientRef;
    if (!relay) {
      showErrorToast("Relay client not available");
      return;
    }
    const result = await relay.selectProxy(proxyId);
    if (!result.success) {
      showErrorToast(`选择 Proxy 失败: ${result.error ?? "unknown"}`);
      return;
    }
    localStorage.setItem("cc_proxyId", proxyId);
    useAppStore.getState().setProxy(proxyId, proxyName ?? null);
    useAppStore.getState().setProxyOnline(true);
    useAppStore.getState().transitionToPhase("session_browsing");
    if (layout === "page") {
      navigate("/sessions");
    }
  }

  if (layout === "page") {
    if (proxies.length === 0) {
      return <EmptyState variant="no-proxy" />;
    }
    return (
      <div className="flex flex-col gap-2 p-4 h-full overflow-auto">
        <h2 className="text-lg font-semibold mb-2">选择一个 Proxy</h2>
        <ul role="list" className="flex flex-col gap-2">
          {proxies.map((p) => (
            <li key={p.proxyId}>
              <button
                type="button"
                data-slot="proxy-item"
                data-proxy-id={p.proxyId}
                onClick={() => handleSelect(p.proxyId, p.name)}
                className="w-full flex items-center gap-3 px-3 h-11 min-h-[44px] rounded-md border border-border bg-card hover:bg-accent transition-colors text-left"
                aria-pressed={selectedProxyId === p.proxyId}
              >
                <ProxyStatusDot status={p.online ? "online" : "offline"} />
                <span className="text-sm font-normal flex-1">
                  {p.name ?? p.proxyId}
                </span>
                {!p.online && (
                  <span className="text-xs text-muted-foreground">离线</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // layout === "dropdown"
  const currentProxy = proxies.find((p) => p.proxyId === selectedProxyId);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 h-9"
          data-slot="proxy-switcher-trigger"
        >
          <ProxyStatusDot
            status={currentProxy?.online ? "online" : "offline"}
          />
          <span className="text-sm font-normal truncate flex-1 text-left">
            {currentProxy?.name ?? currentProxy?.proxyId ?? "未选择"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-1">
        {proxies.length === 0 ? (
          <div className="text-xs text-muted-foreground p-2">
            没有可用 Proxy
          </div>
        ) : (
          <ul role="list" className="flex flex-col">
            {proxies.map((p) => (
              <li key={p.proxyId}>
                <button
                  type="button"
                  data-slot="proxy-item"
                  data-proxy-id={p.proxyId}
                  onClick={() => handleSelect(p.proxyId, p.name)}
                  className="w-full flex items-center gap-2 px-2 h-9 rounded-md hover:bg-accent transition-colors text-left"
                  aria-pressed={selectedProxyId === p.proxyId}
                >
                  <ProxyStatusDot status={p.online ? "online" : "offline"} />
                  <span className="text-sm font-normal flex-1 truncate">
                    {p.name ?? p.proxyId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
