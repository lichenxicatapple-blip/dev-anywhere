// 状态机事件处理，直接访问 zustand store 和 router，不再通过 PhaseNav 间接注入
import type { ProxyInfo } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { toast } from "@/components/toast";
import { router } from "@/lib/router";
import { ControlErrorCode } from "@/lib/control-error-code";
import { ensureBinding, isBindingError } from "@/services/ensure-binding";
import type { RelayClient } from "@/services/relay-client";
import { useFileStore } from "@/stores/file-store";
import { useSessionStore } from "@/stores/session-store";

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
  const proxyInfoRequest = relay.requestProxyInfo();
  void proxyInfoRequest
    .then((info) => {
      useFileStore.getState().setHomePath(info.homePath);
    })
    .catch(() => undefined);
  void relay
    .requestAgentStatuses()
    .then((statuses) => {
      const store = useSessionStore.getState();
      for (const status of statuses) {
        store.setAgentStatus(status.sessionId, status.payload);
      }
    })
    .catch(() => undefined);
}

function requestSessionHistory(relay: RelayClient): void {
  void relay
    .requestSessionHistory()
    .then((sessions) => {
      useSessionStore.getState().setHistorySessions(sessions);
    })
    .catch(() => undefined);
}

function bindingErrorMessage(code: string): string {
  switch (code) {
    case ControlErrorCode.SESSION_NOT_FOUND:
      return "会话不存在或已关闭";
    case ControlErrorCode.PROXY_OFFLINE:
      return "电脑已离线";
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
    useAppStore.getState().resetProxyListLoaded();
    if (s.phase !== "connecting") {
      useAppStore.getState().setPhase("reconnecting");
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
      toast.warning("当前电脑已离线");
    }
    return;
  }

  // proxy_online: 更新标记并刷新列表
  if (msg.type === "proxy_online") {
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      useAppStore.getState().setProxyOnline(true);
      toast.success("当前电脑已恢复连接");
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
      const urlSessionId = savedProxyId ? null : extractSessionIdFromHash();

      if (!savedProxyId && urlSessionId) {
        // URL 粘贴场景: 无 cc_proxyId 但 URL 里有 /chat/:id, 让 relay 按 sessionId 反查 proxy 自动绑
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
        localStorage.setItem("cc_proxyId", result.proxyId);
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
          // 冷启动绑定成功后拉取 session 列表 + 历史
          requestProxyState(relay);
          requestSessionHistory(relay);
          const savedSessionId = localStorage.getItem("cc_sessionId");
          const currentHash = window.location.hash;
          const sessionStillExists =
            savedSessionId && proxyInfo?.sessions?.includes(savedSessionId);
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
          requestProxyState(relay);
          requestSessionHistory(relay);
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
