import type { DevicePreviewCapability } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { useDevicePreviewStore } from "@/stores/device-preview-store";
import type { RelayClient } from "./relay-client";

let snapshotRequestGeneration = 0;

export function syncDevicePreviewSnapshot(
  relay: RelayClient,
  proxyId: string,
  capability: DevicePreviewCapability | undefined,
  logScope: string,
): void {
  const generation = ++snapshotRequestGeneration;
  const store = useDevicePreviewStore.getState();
  if (!capability) {
    store.setCapabilityUnsupported();
    return;
  }

  store.setCapability(capability);
  if (!capability.supported) {
    store.setCapabilityUnsupported();
    return;
  }

  store.markListLoading();
  void relay
    .requestDevicePreviewList()
    .then((snapshot) => {
      if (
        generation !== snapshotRequestGeneration ||
        useAppStore.getState().selectedProxyId !== proxyId
      ) {
        return;
      }
      useDevicePreviewStore.getState().replaceSnapshot(snapshot);
    })
    .catch((error: unknown) => {
      if (
        generation !== snapshotRequestGeneration ||
        useAppStore.getState().selectedProxyId !== proxyId
      ) {
        return;
      }
      console.error(`[${logScope}] requestDevicePreviewList failed`, error);
    });
}
