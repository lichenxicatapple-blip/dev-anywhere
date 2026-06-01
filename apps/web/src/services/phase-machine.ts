// 状态机事件处理，直接访问 zustand store 和 router，不再通过 PhaseNav 间接注入
import { ControlErrorCode, type ProxyInfo } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { toast } from "@/components/toast";
import { router } from "@/lib/router";
import { ensureBinding, isBindingError } from "@/services/ensure-binding";
import type { RelayClient } from "@/services/relay-client";
import { useFileStore } from "@/stores/file-store";
import { useSessionStore } from "@/stores/session-store";
import { readStorageValue, STORAGE_KEYS, writeStorageValue } from "@/lib/storage-keys";

export interface Timers {
  reconnect: ReturnType<typeof setTimeout> | null;
  coldStartDone: boolean;
}

// 从 hash router URL 提取 /chat/:id 的 sessionId
// 格式: "#/chat/abc?mode=json" -> "abc"
function extractSessionIdFromHash(): string | null {
  const match = window.location.hash.match(/^#\/chat\/([^/?]+)/);
  return match?.[1] ?? null;
}

function requestProxyState(relay: RelayClient): void {
  relay.sendControl({ type: "session_list" });
  void relay
    .requestProxyInfo()
    .then((info) => {
      const fileStore = useFileStore.getState();
      fileStore.setHomePath(info.homePath);
      fileStore.setAgentCli(info.agentCli);
    })
    .catch((err: unknown) => {
      console.error("[phase-machine] requestProxyInfo failed", err);
      toast.error("无法获取开发机信息");
    });
  void relay
    .requestAgentStatuses()
    .then((statuses) => {
      const store = useSessionStore.getState();
      for (const status of statuses) {
        store.setAgentStatus(status.sessionId, status.payload);
      }
    })
    .catch((err: unknown) => {
      // 后台辅助数据，失败仅日志，不打扰用户（避免每次重连飞 toast）
      console.error("[phase-machine] requestAgentStatuses failed", err);
    });
}

function requestSessionHistory(relay: RelayClient): void {
  void relay
    .requestSessionHistory()
    .then((sessions) => {
      useSessionStore.getState().setHistorySessions(sessions);
    })
    .catch((err: unknown) => {
      console.error("[phase-machine] requestSessionHistory failed", err);
      toast.error("无法加载历史会话");
    });
}

async function restoreSelectedProxyBinding(relay: RelayClient, proxy: ProxyInfo): Promise<boolean> {
  const result = await ensureBinding(relay, { proxyId: proxy.proxyId });
  if (isBindingError(result)) return false;

  writeStorageValue("local", STORAGE_KEYS.proxyId, proxy.proxyId);
  useAppStore.getState().setProxy(proxy.proxyId, proxy.name ?? null);
  useAppStore.getState().setProxyOnline(true);
  requestProxyState(relay);
  requestSessionHistory(relay);
  return true;
}

function bindingErrorMessage(code: string): string {
  switch (code) {
    case ControlErrorCode.SESSION_NOT_FOUND:
      return "会话不存在或已关闭";
    case ControlErrorCode.PROXY_OFFLINE:
      return "开发机已离线";
    default:
      return "无法打开会话";
  }
}

export function handleWsStatusChange(connected: boolean, timers: Timers, relay: RelayClient): void {
  useAppStore.getState().setConnected(connected);
  const s = useAppStore.getState();
  if (connected) {
    relay.register();

    if (s.phase === "connecting") {
      useAppStore.getState().setPhase("registering");
    }

    if (s.phase === "reconnecting") {
      relay.listProxies();
    }

    if (timers.reconnect) {
      clearTimeout(timers.reconnect);
      timers.reconnect = null;
    }
  } else {
    useAppStore.getState().setProxyOnline(false);
    useAppStore.getState().setProxies([]);
    useAppStore.getState().resetProxyListLoaded();
    if (s.phase !== "connecting") {
      if (s.phase !== "reconnecting") {
        useAppStore.getState().setPhase("reconnecting");
      }
      if (!timers.reconnect) {
        timers.reconnect = setTimeout(() => {
          timers.reconnect = null;
          timers.coldStartDone = false;
          useAppStore.getState().setProxies([]);
          useAppStore.getState().resetProxyListLoaded();
          useAppStore.getState().transitionToPhase("connecting");
          router.navigate("/");
        }, 10000);
      }
    }
  }
}

export async function handleRelayMessage(
  msg: Record<string, unknown>,
  timers: Timers,
  relay: RelayClient,
): Promise<void> {
  const s = useAppStore.getState();

  // client_register_response: 从 registering 转入 proxy_selecting
  if (msg.type === "client_register_response") {
    if (s.phase === "registering") {
      relay.listProxies();
      useAppStore.getState().setPhase("proxy_selecting");
    }
    return;
  }

  if (msg.type === "relay_client_kicked") {
    toast.info("这个客户端已被断开");
    return;
  }

  // proxy_offline: 更新标记并刷新列表
  if (msg.type === "proxy_offline") {
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      relay.clearBoundProxy(typeof msg.proxyId === "string" ? msg.proxyId : undefined);
      useAppStore.getState().setProxyOnline(false);
      toast.warning("当前开发机已离线");
    }
    return;
  }

  // proxy_online: 更新标记并刷新列表
  if (msg.type === "proxy_online") {
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      const proxy = useAppStore.getState().proxies.find((p) => p.proxyId === msg.proxyId);
      if (proxy) {
        void restoreSelectedProxyBinding(relay, { ...proxy, online: true });
      } else {
        useAppStore.getState().setProxyOnline(true);
      }
      toast.success("当前开发机已恢复连接");
    }
    return;
  }

  if (msg.type === "proxy_list_response") {
    const proxies = msg.proxies as ProxyInfo[];
    useAppStore.getState().setProxies(proxies);

    // 冷启动：首次 proxy_list_response 时在 proxy_selecting 阶段执行
    if (!timers.coldStartDone && s.phase === "proxy_selecting") {
      timers.coldStartDone = true;
      const savedProxyId = readStorageValue("local", STORAGE_KEYS.proxyId);
      const urlSessionId = savedProxyId ? null : extractSessionIdFromHash();

      if (!savedProxyId && urlSessionId) {
        // URL 粘贴场景: 无已保存 proxy 但 URL 里有 /chat/:id, 让 relay 按 sessionId 反查 proxy 自动绑
        const result = await ensureBinding(relay, { sessionId: urlSessionId });
        if (isBindingError(result)) {
          const errMsg = bindingErrorMessage(result.code);
          useAppStore.getState().setPendingToast({ kind: "error", message: errMsg });
          router.navigate("/");
          timers.coldStartDone = false;
          return;
        }
        const proxyInfo = proxies.find((p) => p.proxyId === result.proxyId);
        useAppStore.getState().setProxy(result.proxyId, proxyInfo?.name || null);
        useAppStore.getState().setProxyOnline(true);
        writeStorageValue("local", STORAGE_KEYS.proxyId, result.proxyId);
        useAppStore.getState().setPhase("chatting");
        requestProxyState(relay);
        return;
      }

      if (!savedProxyId) {
        // no-op, coldStartDone already true
      } else {
        const result = await ensureBinding(relay, { proxyId: savedProxyId });
        if (!isBindingError(result)) {
          const proxyInfo = proxies.find((p) => p.proxyId === savedProxyId);
          useAppStore.getState().setProxy(savedProxyId, proxyInfo?.name || null);
          useAppStore.getState().setProxyOnline(true);
          // 冷启动绑定成功后拉取 session 列表 + 历史; 路由由 route-restore (AppShell)
          // 按 last-chat-route 决定, 这里只推进 phase 状态。
          requestProxyState(relay);
          requestSessionHistory(relay);
          useAppStore.getState().setPhase("session_browsing");
          return;
        }
        timers.coldStartDone = false;
      }
    }

    // 重连验证
    if (s.selectedProxyId) {
      const selected = proxies.find((p) => p.proxyId === s.selectedProxyId);
      useAppStore.getState().setProxyOnline(selected?.online ?? false);
      const needsBindingRestore =
        selected?.online === true && relay.getBoundProxyId() !== selected.proxyId;

      if (s.phase === "reconnecting") {
        if (selected?.online) {
          const restored = await restoreSelectedProxyBinding(relay, selected);
          if (restored) {
            useAppStore.getState().transitionToPhase(s.phaseBeforeDisconnect ?? "session_browsing");
          }
        }
        return;
      }

      // relay 重启后 proxy 延迟上线：phase 已到 proxy_selecting 但 proxy 现在上线了，自动重新绑定
      if (s.phase === "proxy_selecting" && selected?.online) {
        const restored = await restoreSelectedProxyBinding(relay, selected);
        if (restored) {
          useAppStore.getState().transitionToPhase("session_browsing");
          router.navigate("/sessions");
        }
        return;
      }

      if (needsBindingRestore) {
        await restoreSelectedProxyBinding(relay, selected);
      }
    }
  }
}
