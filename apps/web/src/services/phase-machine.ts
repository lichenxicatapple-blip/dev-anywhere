// 状态机事件处理，直接访问 zustand store 和 router，不再通过 PhaseNav 间接注入
import type { ProxyInfo } from "@cc-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { useToastStore } from "@/stores/toast-store";
import { router } from "@/lib/router";
import { ensureBinding, isBindingError } from "@/services/ensure-binding";
import type { RelayClient } from "@/services/relay-client";

export interface Timers {
  reconnect: ReturnType<typeof setTimeout> | null;
  coldStartDone: boolean;
}

export function handleWsStatusChange(
  connected: boolean,
  timers: Timers,
  relay: RelayClient,
): void {
  useAppStore.getState().setConnected(connected);
  const s = useAppStore.getState();
  if (connected) {
    relay.register();

    if (s.phase === "connecting") {
      useAppStore.getState().setPhase("registering");
    }

    if (s.phase === "reconnecting") {
      relay.listProxies();
      if (s.selectedProxyId) {
        void relay.selectProxy(s.selectedProxyId);
      }
    }

    if (timers.reconnect) {
      clearTimeout(timers.reconnect);
      timers.reconnect = null;
    }
  } else {
    useAppStore.getState().setProxyOnline(false);
    useAppStore.getState().setProxies([]);
    if (s.phase !== "connecting") {
      useAppStore.getState().setPhase("reconnecting");
      timers.reconnect = setTimeout(() => {
        timers.reconnect = null;
        timers.coldStartDone = false;
        useAppStore.getState().setProxies([]);
        useAppStore.getState().transitionToPhase("connecting");
        router.navigate("/");
      }, 10000);
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

  // proxy_offline: 更新标记并刷新列表
  if (msg.type === "proxy_offline") {
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      useAppStore.getState().setProxyOnline(false);
      useToastStore.getState().showToast("Proxy offline");
    }
    return;
  }

  // proxy_online: 更新标记并刷新列表
  if (msg.type === "proxy_online") {
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      useAppStore.getState().setProxyOnline(true);
      useToastStore.getState().showToast("Proxy reconnected");
    }
    return;
  }

  if (msg.type === "proxy_list_response") {
    const proxies = msg.proxies as ProxyInfo[];
    useAppStore.getState().setProxies(proxies);

    // 冷启动：首次 proxy_list_response 时在 proxy_selecting 阶段执行
    if (!timers.coldStartDone && s.phase === "proxy_selecting") {
      timers.coldStartDone = true;
      const savedProxyId = localStorage.getItem("cc_proxyId");
      if (!savedProxyId) {
        // no-op, coldStartDone already true
      } else {
        const result = await ensureBinding(relay, { proxyId: savedProxyId });
        if (!isBindingError(result)) {
          const proxyInfo = proxies.find((p) => p.proxyId === savedProxyId);
          useAppStore.getState().setProxy(savedProxyId, proxyInfo?.name || null);
          useAppStore.getState().setProxyOnline(true);
          const savedSessionId = localStorage.getItem("cc_sessionId");
          const currentHash = window.location.hash;
          const sessionStillExists = savedSessionId && proxyInfo?.sessions?.includes(savedSessionId);
          if (savedSessionId && sessionStillExists) {
            const mode = localStorage.getItem("cc_sessionMode") || "json";
            useAppStore.getState().setPhase("chatting");
            if (!currentHash.includes("/chat/")) {
              router.navigate(`/chat/${savedSessionId}?mode=${mode}`);
            }
          } else {
            if (savedSessionId && !sessionStillExists) {
              localStorage.removeItem("cc_sessionId");
              localStorage.removeItem("cc_sessionMode");
            }
            useAppStore.getState().setPhase("session_browsing");
          }
          return;
        }
        timers.coldStartDone = false;
      }
    }

    // 重连验证
    if (s.selectedProxyId) {
      const selected = proxies.find((p) => p.proxyId === s.selectedProxyId);
      useAppStore.getState().setProxyOnline(selected?.online ?? false);

      if (s.phase === "reconnecting") {
        if (selected?.online) {
          useAppStore.getState().transitionToPhase(s.phaseBeforeDisconnect ?? "session_browsing");
        } else {
          useAppStore.getState().transitionToPhase("proxy_selecting");
          router.navigate("/");
        }
      }

      // relay 重启后 proxy 延迟上线：phase 已到 proxy_selecting 但 proxy 现在上线了，自动重新绑定
      if (s.phase === "proxy_selecting" && selected?.online) {
        const result = await ensureBinding(relay, { proxyId: s.selectedProxyId });
        if (!isBindingError(result)) {
          useAppStore.getState().setProxyOnline(true);
          const savedSessionId = localStorage.getItem("cc_sessionId");
          const sessionStillExists = savedSessionId && selected.sessions?.includes(savedSessionId);
          if (savedSessionId && sessionStillExists) {
            const mode = localStorage.getItem("cc_sessionMode") || "json";
            useAppStore.getState().transitionToPhase("chatting");
            router.navigate(`/chat/${savedSessionId}?mode=${mode}`);
          } else {
            useAppStore.getState().transitionToPhase("session_browsing");
            router.navigate("/sessions");
          }
        }
      }
    }
  }
}
