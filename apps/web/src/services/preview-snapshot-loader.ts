import type { WebPreviewCapability } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { usePreviewStore } from "@/stores/preview-store";
import type { RelayClient } from "./relay-client";

export function syncWebPreviewSnapshot(
  relay: RelayClient,
  proxyId: string,
  capability: WebPreviewCapability | undefined,
  logScope: string,
): void {
  const store = usePreviewStore.getState();
  if (!capability) {
    store.setCapabilityUnsupported();
    return;
  }

  store.setCapability(capability);
  if (!capability.supported) {
    store.clearPreviewList();
    return;
  }

  store.markListLoading();
  void relay
    .requestWebPreviewList()
    .then((snapshot) => {
      if (useAppStore.getState().selectedProxyId !== proxyId) return;
      usePreviewStore.getState().replaceSnapshot(snapshot);
    })
    .catch((err: unknown) => {
      console.error(`[${logScope}] requestWebPreviewList failed`, err);
    });
}
