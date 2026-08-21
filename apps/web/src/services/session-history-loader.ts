import type { HistorySession } from "@dev-anywhere/shared";
import type { RelayClient } from "@/services/relay-client";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";

export type SessionHistoryLoadResult =
  | { status: "loaded"; sessions: HistorySession[] }
  | { status: "failed"; error: unknown }
  | { status: "stale" }
  | { status: "skipped" };

/**
 * Load the selected proxy's historical sessions without blocking the active-session path.
 * A generation token and a proxy identity check make overlapping refreshes and proxy switches safe.
 */
export async function loadSessionHistory(
  relay: RelayClient,
  timeoutMs?: number,
): Promise<SessionHistoryLoadResult> {
  const requestedProxyId = useAppStore.getState().selectedProxyId;
  if (!requestedProxyId) return { status: "skipped" };

  const generation = useSessionStore.getState().beginHistoryLoad();
  try {
    const sessions =
      timeoutMs === undefined
        ? await relay.requestSessionHistory()
        : await relay.requestSessionHistory(timeoutMs);
    if (useAppStore.getState().selectedProxyId !== requestedProxyId) {
      useSessionStore.getState().cancelHistoryLoad(generation);
      return { status: "stale" };
    }
    if (!useSessionStore.getState().resolveHistoryLoad(generation, sessions)) {
      return { status: "stale" };
    }
    return { status: "loaded", sessions };
  } catch (error) {
    if (useAppStore.getState().selectedProxyId !== requestedProxyId) {
      useSessionStore.getState().cancelHistoryLoad(generation);
      return { status: "stale" };
    }
    if (!useSessionStore.getState().rejectHistoryLoad(generation)) {
      return { status: "stale" };
    }
    return { status: "failed", error };
  }
}
