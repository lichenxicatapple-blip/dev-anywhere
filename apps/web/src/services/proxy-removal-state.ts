import type { RelayClient } from "@/services/relay-client";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { useCommandStore } from "@/stores/command-store";
import { useFileStore } from "@/stores/file-store";
import { useSessionStore } from "@/stores/session-store";
import { readStorageValue, removeStorageValue, STORAGE_KEYS } from "@/lib/storage-keys";
import { clearLastChatRoute } from "@/lib/route-restore";

const PENDING_PROXY_REMOVALS_KEY = "dev_anywhere_pending_proxy_removals";

function readPendingProxyRemovals(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(PENDING_PROXY_REMOVALS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function writePendingProxyRemovals(proxyIds: string[]): void {
  try {
    if (proxyIds.length === 0) {
      globalThis.sessionStorage?.removeItem(PENDING_PROXY_REMOVALS_KEY);
    } else {
      globalThis.sessionStorage?.setItem(
        PENDING_PROXY_REMOVALS_KEY,
        JSON.stringify([...new Set(proxyIds)]),
      );
    }
  } catch {
    // Private browsing and embedded WebViews may make storage unavailable.
  }
}

export function markPendingProxyRemoval(proxyId: string): void {
  writePendingProxyRemovals([...readPendingProxyRemovals(), proxyId]);
}

export function clearPendingProxyRemoval(proxyId: string): void {
  writePendingProxyRemovals(readPendingProxyRemovals().filter((id) => id !== proxyId));
}

export function getPendingProxyRemovals(): string[] {
  return readPendingProxyRemovals();
}

/**
 * Applies the local half of an authoritative proxy removal. ACKs, broadcasts, retries that return
 * PROXY_NOT_FOUND, and a post-disconnect list reconciliation all share this idempotent path.
 * Returns true when the removed ID was the current or cold-start-pending selection.
 */
export function applyExplicitProxyRemovalState(proxyId: string, relay: RelayClient): boolean {
  const app = useAppStore.getState();
  const savedProxyId = readStorageValue("local", STORAGE_KEYS.proxyId);
  const removesCurrentSelection = app.selectedProxyId === proxyId;
  const removesPendingColdStartSelection = app.selectedProxyId === null && savedProxyId === proxyId;

  app.setProxies(app.proxies.filter((proxy) => proxy.proxyId !== proxyId));
  relay.clearBoundProxy(proxyId);
  useSessionStore.getState().revokeProxyAuthorizations(proxyId);
  clearPendingProxyRemoval(proxyId);

  if (savedProxyId === proxyId) {
    removeStorageValue("local", STORAGE_KEYS.proxyId);
    clearLastChatRoute();
  }

  if (!removesCurrentSelection && !removesPendingColdStartSelection) return false;

  useSessionStore.getState().clearForProxyRemoval(proxyId);
  useFileStore.getState().prepareForProxySwitch();
  useChatStore.getState().clearAllSessions();
  useCommandStore.getState().clear();
  clearLastChatRoute();

  const latestApp = useAppStore.getState();
  latestApp.setProxySwitchTarget(null);
  latestApp.setProxy(null, null);
  latestApp.setProxyOnline(false);
  latestApp.transitionToPhase("proxy_selecting");
  return true;
}
