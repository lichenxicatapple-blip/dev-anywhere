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

const RECONNECT_GRACE_PERIOD_MS = 30_000;
const RECONNECT_BINDING_RETRY_INITIAL_MS = 500;
const RECONNECT_BINDING_RETRY_MAX_MS = 2_000;

export interface Timers {
  reconnect: ReturnType<typeof setTimeout> | null;
  bindingRetry: ReturnType<typeof setTimeout> | null;
  bindingRetryAttempt: number;
  bindingAttemptGeneration: number | null;
  recoveryGeneration: number;
  coldStartDone: boolean;
  disposed: boolean;
}

export function createPhaseMachineTimers(): Timers {
  return {
    reconnect: null,
    bindingRetry: null,
    bindingRetryAttempt: 0,
    bindingAttemptGeneration: null,
    recoveryGeneration: 0,
    coldStartDone: false,
    disposed: false,
  };
}

// 从 hash router URL 提取 /chat/:id 的 sessionId
// 格式: "#/chat/abc?mode=json" -> "abc"
function extractSessionIdFromHash(): string | null {
  const match = window.location.hash.match(/^#\/chat\/([^/?]+)/);
  return match?.[1] ?? null;
}

function requestProxyState(relay: RelayClient): void {
  const requestedProxyId = useAppStore.getState().selectedProxyId;
  if (!requestedProxyId) return;
  relay.sendControl({ type: "session_list" });
  void relay
    .requestProxyInfo()
    .then((info) => {
      if (useAppStore.getState().selectedProxyId !== requestedProxyId) return;
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
      if (useAppStore.getState().selectedProxyId !== requestedProxyId) return;
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
  const requestedProxyId = useAppStore.getState().selectedProxyId;
  if (!requestedProxyId) return;
  void relay
    .requestSessionHistory(RECONNECT_GRACE_PERIOD_MS)
    .then((sessions) => {
      if (useAppStore.getState().selectedProxyId !== requestedProxyId) return;
      useSessionStore.getState().setHistorySessions(sessions);
    })
    .catch((err: unknown) => {
      console.error("[phase-machine] requestSessionHistory failed", err);
      const app = useAppStore.getState();
      // 手机唤醒时，旧连接上的请求会随 socket 断开而失败；新连接随后会重新同步。
      // 只有连接已经稳定后仍然失败，才向用户报告真正需要关注的问题。
      if (!app.connected || !app.proxyOnline || app.phase === "reconnecting") return;
      toast.warning("历史会话加载可能遇到问题，仍在等待开发机返回");
    });
}

async function restoreSelectedProxyBinding(
  relay: RelayClient,
  proxy: ProxyInfo,
  shouldCommit: () => boolean = () => true,
): Promise<boolean> {
  const result = await ensureBinding(relay, { proxyId: proxy.proxyId });
  if (isBindingError(result) || !shouldCommit()) return false;

  writeStorageValue("local", STORAGE_KEYS.proxyId, proxy.proxyId);
  useAppStore.getState().setProxy(proxy.proxyId, proxy.name ?? null);
  useAppStore.getState().setProxyOnline(true);
  requestProxyState(relay);
  requestSessionHistory(relay);
  return true;
}

function clearReconnectFallback(timers: Timers): void {
  if (!timers.reconnect) return;
  clearTimeout(timers.reconnect);
  timers.reconnect = null;
}

function invalidateBindingRecovery(timers: Timers): void {
  timers.recoveryGeneration += 1;
  timers.bindingAttemptGeneration = null;
  timers.bindingRetryAttempt = 0;
  if (!timers.bindingRetry) return;
  clearTimeout(timers.bindingRetry);
  timers.bindingRetry = null;
}

function clearReconnectRecovery(timers: Timers): void {
  clearReconnectFallback(timers);
  invalidateBindingRecovery(timers);
}

function ensureReconnectFallback(timers: Timers): void {
  if (timers.reconnect || timers.disposed) return;
  timers.reconnect = setTimeout(() => {
    timers.reconnect = null;
    invalidateBindingRecovery(timers);
    if (timers.disposed || useAppStore.getState().phase !== "reconnecting") return;

    timers.coldStartDone = false;
    useAppStore.getState().setProxyOnline(false);
    useAppStore.getState().setProxies([]);
    useAppStore.getState().resetProxyListLoaded();
    useAppStore.getState().transitionToPhase("connecting");
    router.navigate("/");
  }, RECONNECT_GRACE_PERIOD_MS);
}

function reconnectBindingIsCurrent(timers: Timers, generation: number, proxyId: string): boolean {
  const app = useAppStore.getState();
  return (
    !timers.disposed &&
    timers.recoveryGeneration === generation &&
    timers.bindingAttemptGeneration === generation &&
    app.connected &&
    app.phase === "reconnecting" &&
    app.selectedProxyId === proxyId
  );
}

function scheduleReconnectBindingRetry(
  timers: Timers,
  relay: RelayClient,
  proxy: ProxyInfo,
  generation: number,
): void {
  if (timers.bindingRetry || timers.disposed || timers.recoveryGeneration !== generation) return;

  const backoffExponent = Math.min(timers.bindingRetryAttempt, 2);
  const delay = Math.min(
    RECONNECT_BINDING_RETRY_INITIAL_MS * 2 ** backoffExponent,
    RECONNECT_BINDING_RETRY_MAX_MS,
  );
  timers.bindingRetryAttempt += 1;
  timers.bindingRetry = setTimeout(() => {
    timers.bindingRetry = null;
    if (
      timers.disposed ||
      timers.recoveryGeneration !== generation ||
      useAppStore.getState().phase !== "reconnecting"
    ) {
      return;
    }
    void attemptReconnectBinding(timers, relay, proxy, generation);
  }, delay);
}

async function attemptReconnectBinding(
  timers: Timers,
  relay: RelayClient,
  proxy: ProxyInfo,
  generation = timers.recoveryGeneration,
): Promise<void> {
  const app = useAppStore.getState();
  if (
    timers.disposed ||
    timers.recoveryGeneration !== generation ||
    timers.bindingAttemptGeneration !== null ||
    !app.connected ||
    app.phase !== "reconnecting" ||
    app.selectedProxyId !== proxy.proxyId
  ) {
    return;
  }

  if (timers.bindingRetry) {
    clearTimeout(timers.bindingRetry);
    timers.bindingRetry = null;
  }
  timers.bindingAttemptGeneration = generation;
  const restored = await restoreSelectedProxyBinding(relay, proxy, () =>
    reconnectBindingIsCurrent(timers, generation, proxy.proxyId),
  );

  if (!reconnectBindingIsCurrent(timers, generation, proxy.proxyId)) return;
  timers.bindingAttemptGeneration = null;

  if (restored) {
    const phaseBeforeDisconnect = useAppStore.getState().phaseBeforeDisconnect;
    clearReconnectRecovery(timers);
    useAppStore.getState().transitionToPhase(phaseBeforeDisconnect ?? "session_browsing");
    return;
  }

  useAppStore.getState().setProxyOnline(false);
  scheduleReconnectBindingRetry(timers, relay, proxy, generation);
}

export function disposePhaseMachineTimers(timers: Timers): void {
  timers.disposed = true;
  clearReconnectRecovery(timers);
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
  if (timers.disposed) return;
  useAppStore.getState().setConnected(connected);
  const s = useAppStore.getState();
  if (connected) {
    // A new raw socket invalidates any proxy_select still pending on the previous transport.
    // Input stays disabled until the selected proxy binding is acknowledged below.
    invalidateBindingRecovery(timers);
    relay.register();

    if (s.phase === "connecting") {
      useAppStore.getState().setPhase("registering");
    }

    if (s.phase === "reconnecting") {
      useAppStore.getState().setProxyOnline(false);
      ensureReconnectFallback(timers);
      relay.listProxies();
    }
  } else {
    invalidateBindingRecovery(timers);
    useAppStore.getState().setProxyOnline(false);
    useAppStore.getState().setProxies([]);
    useAppStore.getState().resetProxyListLoaded();
    if (s.phase !== "connecting") {
      if (s.phase !== "reconnecting") {
        useAppStore.getState().setPhase("reconnecting");
      }
      ensureReconnectFallback(timers);
    }
  }
}

export async function handleRelayMessage(
  msg: Record<string, unknown>,
  timers: Timers,
  relay: RelayClient,
): Promise<void> {
  if (timers.disposed) return;
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
      invalidateBindingRecovery(timers);
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
      const alreadyBound = relay.getBoundProxyId() === msg.proxyId;
      if (alreadyBound && s.phase !== "reconnecting") {
        useAppStore.getState().setProxyOnline(true);
        toast.success("当前开发机已恢复连接");
        return;
      }

      useAppStore.getState().setProxyOnline(false);
      const proxy = useAppStore.getState().proxies.find((p) => p.proxyId === msg.proxyId);
      if (proxy) {
        const onlineProxy = { ...proxy, online: true };
        if (s.phase === "reconnecting") {
          await attemptReconnectBinding(timers, relay, onlineProxy);
        } else if (await restoreSelectedProxyBinding(relay, onlineProxy)) {
          toast.success("当前开发机已恢复连接");
        }
      }
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
      const hasConfirmedBinding =
        selected?.online === true && relay.getBoundProxyId() === selected.proxyId;
      useAppStore.getState().setProxyOnline(hasConfirmedBinding);
      const needsBindingRestore = selected?.online === true && !hasConfirmedBinding;

      if (s.phase === "reconnecting") {
        if (selected?.online) {
          await attemptReconnectBinding(timers, relay, selected);
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
