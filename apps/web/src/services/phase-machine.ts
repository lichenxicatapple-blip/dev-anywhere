// 状态机事件处理，直接访问 zustand store 和 router，不再通过 PhaseNav 间接注入
import { ControlErrorCode, type ProxyInfo } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { toast } from "@/components/toast";
import { router } from "@/lib/router";
import { ensureBinding, isBindingError } from "@/services/ensure-binding";
import type { RelayClient } from "@/services/relay-client";
import { useFileStore } from "@/stores/file-store";
import { useSessionStore } from "@/stores/session-store";
import { previewController } from "@/services/preview-controller";
import type { PreviewScope } from "@/services/preview-scope";
import { readStorageValue, STORAGE_KEYS, writeStorageValue } from "@/lib/storage-keys";
import { loadSessionHistory } from "@/services/session-history-loader";
import {
  applyExplicitProxyRemovalState,
  clearPendingProxyRemoval,
  getPendingProxyRemovals,
} from "@/services/proxy-removal-state";

const RECONNECT_GRACE_PERIOD_MS = 30_000;
// 本机 650+ 个历史文件约 2.2s 扫完；给移动弱网留充足余量，但不要让失败请求锁住刷新整整 30s。
const SESSION_HISTORY_LOAD_TIMEOUT_MS = 15_000;
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

function activatePreviewBinding(relay: RelayClient, proxyId: string): PreviewScope | null {
  const scope = relay.getPreviewScope();
  if (!scope || scope.proxyId !== proxyId) {
    previewController.dispose();
    console.error("[phase-machine] Relay acknowledged a binding without a matching preview scope");
    return null;
  }
  previewController.activate(relay, scope);
  return scope;
}

function previewBindingIsCurrent(relay: RelayClient, scope: PreviewScope): boolean {
  return (
    useAppStore.getState().selectedProxyId === scope.proxyId &&
    previewController.isActive(relay, scope)
  );
}

function requestProxyState(relay: RelayClient, scope: PreviewScope): void {
  if (!previewBindingIsCurrent(relay, scope)) return;
  relay.sendControl({ type: "session_list" });
  void previewController.syncWebSnapshot(scope).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") return;
    console.error("[phase-machine] requestWebPreviewList failed", error);
  });
  void previewController.syncDeviceSnapshot(scope).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") return;
    console.error("[phase-machine] requestDevicePreviewList failed", error);
  });
  void relay
    .requestProxyInfo()
    .then((info) => {
      if (!previewBindingIsCurrent(relay, scope)) return;
      const fileStore = useFileStore.getState();
      fileStore.setHomePath(info.homePath);
      fileStore.setAgentCli(info.agentCli);
    })
    .catch((err: unknown) => {
      if (!previewBindingIsCurrent(relay, scope)) return;
      console.error("[phase-machine] requestProxyInfo failed", err);
      toast.error("无法获取开发机信息");
    });
  void relay
    .requestAgentStatuses()
    .then((statuses) => {
      if (!previewBindingIsCurrent(relay, scope)) return;
      const store = useSessionStore.getState();
      for (const status of statuses) {
        store.setAgentStatus(status.sessionId, status.payload);
      }
    })
    .catch((err: unknown) => {
      if (!previewBindingIsCurrent(relay, scope)) return;
      // 后台辅助数据，失败仅日志，不打扰用户（避免每次重连飞 toast）
      console.error("[phase-machine] requestAgentStatuses failed", err);
    });
}

function requestSessionHistory(relay: RelayClient): void {
  void loadSessionHistory(relay, SESSION_HISTORY_LOAD_TIMEOUT_MS).then((result) => {
    if (result.status === "failed") {
      console.error("[phase-machine] requestSessionHistory failed", result.error);
      const app = useAppStore.getState();
      // 手机唤醒时，旧连接上的请求会随 socket 断开而失败；新连接随后会重新同步。
      // 只有连接已经稳定后仍然失败，才向用户报告真正需要关注的问题。
      if (!app.connected || !app.proxyOnline || app.phase === "reconnecting") return;
      toast.warning("历史会话加载失败，可点击刷新重试");
    }
  });
}

async function restoreSelectedProxyBinding(
  relay: RelayClient,
  proxy: ProxyInfo,
  shouldCommit: () => boolean = () => true,
): Promise<boolean> {
  const result = await ensureBinding(relay, { proxyId: proxy.proxyId });
  if (isBindingError(result) || !shouldCommit()) return false;
  const scope = activatePreviewBinding(relay, result.proxyId);
  if (!scope) return false;

  writeStorageValue("local", STORAGE_KEYS.proxyId, proxy.proxyId);
  useAppStore.getState().setProxy(proxy.proxyId, proxy.name ?? null);
  useAppStore.getState().setProxyOnline(true);
  requestProxyState(relay, scope);
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

function handleExplicitProxyRemoval(proxyId: string, timers: Timers, relay: RelayClient): void {
  // ACK 负责请求标签页、proxy_removed 负责其他标签页；两条消息都会走这里，因此清理必须幂等。
  const clearedSelection = applyExplicitProxyRemovalState(proxyId, relay);
  if (!clearedSelection) return;
  clearReconnectRecovery(timers);
  router.navigate("/");
}

function ensureReconnectFallback(timers: Timers): void {
  if (timers.reconnect || timers.disposed) return;
  timers.reconnect = setTimeout(() => {
    timers.reconnect = null;
    invalidateBindingRecovery(timers);
    if (timers.disposed || useAppStore.getState().phase !== "reconnecting") return;

    timers.coldStartDone = false;
    previewController.dispose();
    useAppStore.getState().setProxyOnline(false);
    useAppStore.getState().invalidateProxyList();
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
  previewController.dispose();
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
    previewController.dispose();
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
    previewController.dispose();
    useAppStore.getState().setProxyOnline(false);
    useAppStore.getState().invalidateProxyList();
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
    if (
      (msg.status === "restored" || msg.status === "proxy_offline") &&
      typeof msg.proxyId === "string"
    ) {
      activatePreviewBinding(relay, msg.proxyId);
    } else {
      previewController.dispose();
    }
    if (s.phase === "registering") {
      relay.listProxies();
      useAppStore.getState().setPhase("proxy_selecting");
    }
    return;
  }

  if (msg.type === "relay_client_kicked") {
    previewController.dispose();
    toast.info("这个客户端已被断开");
    return;
  }

  // 显式移除和 Relay 重启造成的临时空列表语义不同，必须由独立事件驱动清理。
  // 所有已打开的客户端都会收到该事件，避免其他标签页继续持有已删除 proxy 的绑定。
  if (msg.type === "proxy_removed" && typeof msg.proxyId === "string") {
    handleExplicitProxyRemoval(msg.proxyId, timers, relay);
    return;
  }

  // 成功 ACK 也代表权威删除：若紧接着断线导致广播丢失，请求标签页仍能完整清理。
  if (
    msg.type === "proxy_remove_response" &&
    (msg.success === true || msg.errorCode === ControlErrorCode.PROXY_NOT_FOUND) &&
    typeof msg.proxyId === "string"
  ) {
    handleExplicitProxyRemoval(msg.proxyId, timers, relay);
    return;
  }

  // proxy_offline: 更新标记并刷新列表
  if (msg.type === "proxy_offline") {
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      invalidateBindingRecovery(timers);
      previewController.dispose();
      relay.clearBoundProxy(typeof msg.proxyId === "string" ? msg.proxyId : undefined);
      useAppStore.getState().setProxyOnline(false);
      toast.warning("当前开发机已离线");
    }
    return;
  }

  // proxy_online: 更新标记并刷新列表
  if (msg.type === "proxy_online") {
    if (typeof msg.proxyId !== "string") return;
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      const alreadyBound = relay.getBoundProxyId() === msg.proxyId;
      if (alreadyBound && s.phase !== "reconnecting") {
        const scope = activatePreviewBinding(relay, msg.proxyId);
        if (!scope) return;
        useAppStore.getState().setProxyOnline(true);
        requestProxyState(relay, scope);
        requestSessionHistory(relay);
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

    // If a remove request lost every response during a socket drop, its session-scoped intent
    // survives the reconnect. The first authoritative list resolves the ambiguity without ever
    // treating an ordinary Relay restart as a deletion.
    for (const pendingProxyId of getPendingProxyRemovals()) {
      if (proxies.some((proxy) => proxy.proxyId === pendingProxyId)) {
        clearPendingProxyRemoval(pendingProxyId);
        continue;
      }
      const clearedSelection = applyExplicitProxyRemovalState(pendingProxyId, relay);
      if (clearedSelection) {
        clearReconnectRecovery(timers);
        router.navigate("/");
        return;
      }
    }

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
        const scope = activatePreviewBinding(relay, result.proxyId);
        if (!scope) {
          timers.coldStartDone = false;
          return;
        }
        useAppStore.getState().setProxy(result.proxyId, proxyInfo?.name || null);
        useAppStore.getState().setProxyOnline(true);
        writeStorageValue("local", STORAGE_KEYS.proxyId, result.proxyId);
        useAppStore.getState().setPhase("chatting");
        requestProxyState(relay, scope);
        requestSessionHistory(relay);
        return;
      }

      if (!savedProxyId) {
        // no-op, coldStartDone already true
      } else {
        const result = await ensureBinding(relay, { proxyId: savedProxyId });
        if (!isBindingError(result)) {
          const scope = activatePreviewBinding(relay, result.proxyId);
          if (!scope) {
            timers.coldStartDone = false;
            return;
          }
          const proxyInfo = proxies.find((p) => p.proxyId === savedProxyId);
          useAppStore.getState().setProxy(savedProxyId, proxyInfo?.name || null);
          useAppStore.getState().setProxyOnline(true);
          // 冷启动绑定成功后拉取 session 列表 + 历史; 路由由 route-restore (AppShell)
          // 按 last-chat-route 决定, 这里只推进 phase 状态。
          requestProxyState(relay, scope);
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
