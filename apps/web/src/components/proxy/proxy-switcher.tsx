// layout=page 用于移动端/空壳页，选中后进入 /sessions。
// layout=dropdown 用于桌面侧栏顶部，只切换当前绑定的开发机 proxy。
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ChevronDown, Check, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { ControlErrorCode, type ProxyInfo } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { useFileStore } from "@/stores/file-store";
import { usePreviewStore } from "@/stores/preview-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/shell/empty-state";
import { cn } from "@/lib/utils";
import { STORAGE_KEYS, writeStorageValue } from "@/lib/storage-keys";
import { loadSessionHistory } from "@/services/session-history-loader";
import { syncWebPreviewSnapshot } from "@/services/preview-snapshot-loader";
import {
  applyExplicitProxyRemovalState,
  clearPendingProxyRemoval,
  markPendingProxyRemoval,
} from "@/services/proxy-removal-state";
import { ProxyStatusDot } from "./proxy-status-dot";
import { ProxyRemovalDialog, type ProxyRemovalTarget } from "./proxy-removal-dialog";
import { SwipeableOfflineProxyRow } from "./swipeable-offline-proxy-row";

interface ProxySwitcherProps {
  layout: "page" | "dropdown";
  variant?: "default" | "sidebarChrome";
}

export function ProxySwitcher({ layout, variant = "default" }: ProxySwitcherProps) {
  const proxies = useAppStore((s) => s.proxies);
  const proxyListLoaded = useAppStore((s) => s.proxyListLoaded);
  const relayClientAuthIssue = useAppStore((s) => s.relayClientAuthIssue);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const proxySwitchTarget = useAppStore((s) => s.proxySwitchTarget);
  const location = useLocation();
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [revealedProxyId, setRevealedProxyId] = useState<string | null>(null);
  const [removalTarget, setRemovalTarget] = useState<ProxyRemovalTarget | null>(null);
  const [removingProxyId, setRemovingProxyId] = useState<string | null>(null);

  async function handleSelect(proxyId: string, proxyName: string | undefined): Promise<void> {
    if (proxySwitchTarget) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const displayName = proxyName ?? proxyId;
    const isChangingProxy = selectedProxyId !== null && selectedProxyId !== proxyId;
    useAppStore.getState().setProxySwitchTarget({ proxyId, name: displayName });
    try {
      const result = await relay.selectProxy(proxyId);
      if (!result.success) {
        toast.error(`无法连接 ${displayName}：${result.error ?? "未知错误"}`);
        return;
      }
      if (isChangingProxy) {
        useSessionStore.getState().prepareForProxySwitch(displayName);
        useFileStore.getState().prepareForProxySwitch();
        usePreviewStore.getState().prepareForProxySwitch();
      }
      writeStorageValue("local", STORAGE_KEYS.proxyId, proxyId);
      useAppStore.getState().setProxy(proxyId, proxyName ?? null);
      useAppStore.getState().setProxyOnline(true);
      useAppStore.getState().transitionToPhase("session_browsing");
      // 绑定成功后刷新会话列表，并用 request-scoped snapshot 拉取历史和 provider 状态。
      relay.sendControl({ type: "session_list" });
      void relay
        .requestProxyInfo()
        .then((info) => {
          if (useAppStore.getState().selectedProxyId !== proxyId) return;
          const fileStore = useFileStore.getState();
          fileStore.setHomePath(info.homePath);
          fileStore.setAgentCli(info.agentCli);
          syncWebPreviewSnapshot(relay, proxyId, info.webPreview, "proxy-switcher");
        })
        .catch((err: unknown) => {
          console.error("[proxy-switcher] post-bind proxy info fetch failed", err);
        });
      void relay
        .requestAgentStatuses()
        .then((statuses) => {
          if (useAppStore.getState().selectedProxyId !== proxyId) return;
          const store = useSessionStore.getState();
          for (const status of statuses) {
            store.setAgentStatus(status.sessionId, status.payload);
          }
        })
        .catch((err: unknown) => {
          console.error("[proxy-switcher] post-bind data fetch failed", err);
        });
      void loadSessionHistory(relay).then((result) => {
        if (result.status === "failed") {
          console.error("[proxy-switcher] post-bind data fetch failed", result.error);
        }
      });
      setDropdownOpen(false);
      if (layout === "page") {
        navigate("/sessions");
      } else if (location.pathname.startsWith("/chat/")) {
        navigate("/sessions");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知错误";
      toast.error(`无法连接 ${displayName}：${message}`);
    } finally {
      useAppStore.getState().setProxySwitchTarget(null);
    }
  }

  function requestRemoval(proxy: ProxyInfo): void {
    if (proxy.online || removingProxyId) return;
    setRevealedProxyId(null);
    setRemovalTarget({ proxyId: proxy.proxyId, ...(proxy.name ? { name: proxy.name } : {}) });
  }

  async function handleRemove(): Promise<void> {
    const target = removalTarget;
    if (!target || removingProxyId) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("Relay 连接不可用，请稍后重试");
      return;
    }

    // UI 只给离线项入口；确认时再读一次实时列表，服务端还会做最终原子校验。
    const latest = useAppStore.getState().proxies.find((proxy) => proxy.proxyId === target.proxyId);
    if (!latest) {
      if (!useAppStore.getState().proxyListLoaded) {
        toast.info("正在重新连接 Relay，请稍后再试");
        return;
      }
      if (applyExplicitProxyRemovalState(target.proxyId, relay)) navigate("/");
      toast.info("这台开发机已经不在列表中");
      setRemovalTarget(null);
      return;
    }
    if (latest.online) {
      toast.warning("这台开发机已重新上线，未移除");
      setRemovalTarget(null);
      return;
    }

    setRemovingProxyId(target.proxyId);
    markPendingProxyRemoval(target.proxyId);
    try {
      const result = await relay.removeOfflineProxy(target.proxyId);
      if (result.success) {
        clearPendingProxyRemoval(target.proxyId);
        if (applyExplicitProxyRemovalState(target.proxyId, relay)) navigate("/");
        toast.success(`已移除 ${target.name ?? target.proxyId}`);
        setRemovalTarget(null);
        return;
      }
      if (result.errorCode === ControlErrorCode.PROXY_ONLINE) {
        clearPendingProxyRemoval(target.proxyId);
        toast.warning("这台开发机已重新上线，未移除");
        setRemovalTarget(null);
        relay.listProxies();
        return;
      }
      if (result.errorCode === ControlErrorCode.PROXY_NOT_FOUND) {
        // 并发标签页已经移除、或 ACK 丢失后重试，都视为目标状态已达成。
        clearPendingProxyRemoval(target.proxyId);
        if (applyExplicitProxyRemovalState(target.proxyId, relay)) navigate("/");
        toast.info("这台开发机已经不在列表中");
        setRemovalTarget(null);
        relay.listProxies();
        return;
      }
      clearPendingProxyRemoval(target.proxyId);
      toast.error(result.error ?? "无法移除开发机，请重试");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法移除开发机，请重试");
      // A disconnect/timeout leaves delivery ambiguous. Keep the intent until the first fresh
      // proxy list: present means the request did not take effect; absent means it did.
      relay.listProxies();
    } finally {
      setRemovingProxyId(null);
    }
  }

  const removalDialog = (
    <ProxyRemovalDialog
      open={removalTarget !== null}
      target={removalTarget}
      removing={removingProxyId !== null}
      onOpenChange={(open) => {
        if (!open) setRemovalTarget(null);
      }}
      onConfirm={() => void handleRemove()}
    />
  );

  if (layout === "page") {
    if (relayClientAuthIssue === "missing_client_token") {
      return <EmptyState variant="client-token-missing" />;
    }
    if (relayClientAuthIssue === "invalid_client_token") {
      return <EmptyState variant="client-token-invalid" />;
    }
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
      <>
        <div className="flex h-full flex-col gap-3 overflow-auto p-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            开发机
          </h3>
          <ul role="list" className="flex flex-col gap-2">
            {proxies.map((p) => {
              const isSelectingThis = proxySwitchTarget?.proxyId === p.proxyId;
              const isSelectionPending = proxySwitchTarget !== null;
              if (!p.online) {
                return (
                  <SwipeableOfflineProxyRow
                    key={p.proxyId}
                    proxyId={p.proxyId}
                    name={p.name}
                    selected={selectedProxyId === p.proxyId}
                    revealed={revealedProxyId === p.proxyId}
                    disabled={isSelectionPending || removingProxyId !== null}
                    onRevealedChange={(revealed) => setRevealedProxyId(revealed ? p.proxyId : null)}
                    onRemove={() => requestRemoval(p)}
                  />
                );
              }
              return (
                <li key={p.proxyId}>
                  <button
                    type="button"
                    data-slot="proxy-item"
                    data-proxy-id={p.proxyId}
                    data-online="true"
                    data-selecting={isSelectingThis || undefined}
                    disabled={isSelectionPending || removingProxyId !== null}
                    aria-busy={isSelectingThis || undefined}
                    onClick={() => handleSelect(p.proxyId, p.name)}
                    className={cn(
                      "flex h-11 min-h-[44px] w-full items-center gap-3 rounded-md border bg-card px-3 text-left transition-colors disabled:cursor-not-allowed disabled:hover:bg-card",
                      isSelectingThis
                        ? "border-primary/40 bg-accent text-accent-foreground"
                        : "border-border hover:bg-accent",
                      (isSelectionPending && !isSelectingThis) || removingProxyId !== null
                        ? "opacity-50"
                        : "",
                    )}
                    aria-pressed={selectedProxyId === p.proxyId}
                  >
                    <ProxyStatusDot status="online" />
                    <span className="min-w-0 flex-1 truncate text-sm font-normal">
                      {p.name ?? p.proxyId}
                    </span>
                    {isSelectingThis ? (
                      <>
                        <span className="shrink-0 text-xs text-muted-foreground">正在连接</span>
                        <Loader2
                          className="size-4 shrink-0 animate-spin text-primary"
                          aria-hidden
                        />
                      </>
                    ) : selectedProxyId === p.proxyId ? (
                      <Check className="size-4 shrink-0 text-primary" aria-label="已选" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        {removalDialog}
      </>
    );
  }

  // layout === "dropdown": desktop sidebar proxy selector.
  const currentProxy = proxies.find((p) => p.proxyId === selectedProxyId);
  const currentProxyName = currentProxy?.name ?? currentProxy?.proxyId ?? "未选择开发机";
  return (
    <>
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
              {proxies.map((p) => {
                const isSelectingThis = proxySwitchTarget?.proxyId === p.proxyId;
                const isSelectionPending = proxySwitchTarget !== null;
                return (
                  <li key={p.proxyId} className="group flex min-w-0 items-center rounded-md">
                    <button
                      type="button"
                      data-slot="proxy-item"
                      data-proxy-id={p.proxyId}
                      data-online={p.online}
                      data-selecting={isSelectingThis || undefined}
                      disabled={!p.online || isSelectionPending}
                      aria-busy={isSelectingThis || undefined}
                      onClick={() => handleSelect(p.proxyId, p.name)}
                      className={cn(
                        "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left transition-colors disabled:cursor-not-allowed disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSelectingThis ? "bg-accent text-accent-foreground" : "hover:bg-accent",
                        isSelectionPending && !isSelectingThis ? "opacity-50" : "",
                        !p.online ? "opacity-50" : "",
                      )}
                      aria-pressed={selectedProxyId === p.proxyId}
                      title={!p.online ? "这台开发机离线" : undefined}
                    >
                      <ProxyStatusDot status={p.online ? "online" : "offline"} />
                      <span className="text-sm font-normal flex-1 truncate min-w-0">
                        {p.name ?? p.proxyId}
                      </span>
                      {isSelectingThis ? (
                        <Loader2
                          className="h-4 w-4 animate-spin text-primary shrink-0"
                          aria-label="正在连接"
                        />
                      ) : selectedProxyId === p.proxyId ? (
                        <Check className="h-4 w-4 text-primary shrink-0" aria-label="已选" />
                      ) : null}
                      {!p.online && !isSelectingThis && (
                        <span className="text-xs text-muted-foreground shrink-0">离线</span>
                      )}
                    </button>
                    {!p.online && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="mr-1 size-8 text-muted-foreground opacity-60 hover:opacity-100 focus-visible:opacity-100"
                            disabled={isSelectionPending || removingProxyId !== null}
                            aria-label={`${p.name ?? p.proxyId} 操作`}
                            data-slot="proxy-row-menu-trigger"
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" data-slot="proxy-row-menu">
                          <DropdownMenuItem
                            variant="destructive"
                            data-slot="proxy-row-remove-item"
                            onSelect={(event) => {
                              event.stopPropagation();
                              requestRemoval(p);
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                            移除开发机
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      {removalDialog}
    </>
  );
}
