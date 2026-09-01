import { useState } from "react";
import type { DevicePreviewSummary, PreviewSummary } from "@dev-anywhere/shared";
import { useMatch, useNavigate } from "react-router";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { usePreviewStore } from "@/stores/preview-store";
import { toast } from "@/components/toast";
import { PreviewCloseDialog } from "./preview-close-dialog";
import { PreviewRow } from "./preview-row";
import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { DevicePreviewRow } from "./device-preview-row";
import { DevicePreviewCloseDialog } from "./device-preview-close-dialog";

export function PreviewList() {
  const previews = usePreviewStore((state) => state.previews);
  const devicePreviews = useDevicePreviewStore((state) => state.previews);
  const deviceMatch = useMatch("/preview/device/:id");
  const navigate = useNavigate();
  const [pendingClose, setPendingClose] = useState<PreviewSummary | null>(null);
  const [pendingDeviceClose, setPendingDeviceClose] = useState<DevicePreviewSummary | null>(null);
  const [closingPreviewId, setClosingPreviewId] = useState<string | null>(null);
  const [reconnectingPreviewId, setReconnectingPreviewId] = useState<string | null>(null);
  const [closingDevicePreviewId, setClosingDevicePreviewId] = useState<string | null>(null);
  const [reconnectingDevicePreviewId, setReconnectingDevicePreviewId] = useState<string | null>(
    null,
  );

  if (previews.length === 0 && devicePreviews.length === 0) return null;

  async function reconnectPreview(preview: PreviewSummary): Promise<void> {
    if (reconnectingPreviewId) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const previousState = preview.state;
    setReconnectingPreviewId(preview.previewId);
    usePreviewStore.getState().setPreviewState(preview.previewId, "starting");
    try {
      const result = await relay.reconnectWebPreview(preview.previewId);
      if (!result.success) {
        usePreviewStore.getState().setPreviewState(preview.previewId, previousState);
        toast.error(result.error ?? "无法重新连接网页预览");
      }
    } catch (error) {
      usePreviewStore.getState().setPreviewState(preview.previewId, previousState);
      toast.error(error instanceof Error ? error.message : "无法重新连接网页预览");
    } finally {
      setReconnectingPreviewId(null);
    }
  }

  async function closePreview(preview: PreviewSummary): Promise<void> {
    if (closingPreviewId) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const previousState = preview.state;
    setClosingPreviewId(preview.previewId);
    usePreviewStore.getState().setPreviewState(preview.previewId, "stopping");
    try {
      const result = await relay.closeWebPreview(preview.previewId);
      if (!result.success) {
        usePreviewStore.getState().setPreviewState(preview.previewId, previousState);
        toast.error(result.error ?? "无法关闭网页预览");
        return;
      }
      setPendingClose(null);
      // Keep the stopping row until preview_removed_push confirms the public entry is gone.
    } catch (error) {
      usePreviewStore.getState().setPreviewState(preview.previewId, previousState);
      toast.error(error instanceof Error ? error.message : "无法关闭网页预览");
    } finally {
      setClosingPreviewId(null);
    }
  }

  async function reconnectDevicePreview(preview: DevicePreviewSummary): Promise<void> {
    if (reconnectingDevicePreviewId) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const previousState = preview.state;
    setReconnectingDevicePreviewId(preview.previewId);
    useDevicePreviewStore.getState().setPreviewState(preview.previewId, "starting");
    try {
      const result = await relay.reconnectDevicePreview(preview.previewId);
      if (!result.success) {
        useDevicePreviewStore
          .getState()
          .setPreviewStateIf(preview.previewId, "starting", previousState);
        toast.error(result.error ?? "无法重新连接模拟器预览");
      }
    } catch (error) {
      useDevicePreviewStore
        .getState()
        .setPreviewStateIf(preview.previewId, "starting", previousState);
      toast.error(error instanceof Error ? error.message : "无法重新连接模拟器预览");
    } finally {
      setReconnectingDevicePreviewId(null);
    }
  }

  async function closeDevicePreview(preview: DevicePreviewSummary): Promise<void> {
    if (closingDevicePreviewId) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const previousState = preview.state;
    setClosingDevicePreviewId(preview.previewId);
    useDevicePreviewStore.getState().setPreviewState(preview.previewId, "stopping");
    try {
      const result = await relay.closeDevicePreview(preview.previewId);
      if (!result.success) {
        useDevicePreviewStore
          .getState()
          .setPreviewStateIf(preview.previewId, "stopping", previousState);
        toast.error(result.error ?? "无法停止模拟器预览");
        return;
      }
      setPendingDeviceClose(null);
      if (deviceMatch?.params.id === preview.previewId) navigate("/sessions");
    } catch (error) {
      useDevicePreviewStore
        .getState()
        .setPreviewStateIf(preview.previewId, "stopping", previousState);
      toast.error(error instanceof Error ? error.message : "无法停止模拟器预览");
    } finally {
      setClosingDevicePreviewId(null);
    }
  }

  return (
    <section data-slot="preview-section" aria-labelledby="preview-section-title">
      <h3
        id="preview-section-title"
        className="px-4 pb-2 pt-3 text-sm font-semibold text-foreground"
      >
        前端预览
        <span className="ml-1 font-normal text-muted-foreground/70">
          · {previews.length + devicePreviews.length}
        </span>
      </h3>
      <ul role="list" className="flex w-full min-w-0 flex-col">
        {previews.map((preview) => (
          <PreviewRow
            key={preview.previewId}
            preview={preview}
            onReconnect={() => void reconnectPreview(preview)}
            onClose={() => setPendingClose(preview)}
          />
        ))}
        {devicePreviews.map((preview) => (
          <DevicePreviewRow
            key={preview.previewId}
            preview={preview}
            selected={deviceMatch?.params.id === preview.previewId}
            onReconnect={() => void reconnectDevicePreview(preview)}
            onClose={() => setPendingDeviceClose(preview)}
          />
        ))}
      </ul>
      <PreviewCloseDialog
        preview={pendingClose}
        closing={closingPreviewId !== null}
        onOpenChange={(open) => {
          if (!open && !closingPreviewId) setPendingClose(null);
        }}
        onConfirm={(preview) => void closePreview(preview)}
      />
      <DevicePreviewCloseDialog
        preview={pendingDeviceClose}
        closing={closingDevicePreviewId !== null}
        onOpenChange={(open) => {
          if (!open && !closingDevicePreviewId) setPendingDeviceClose(null);
        }}
        onConfirm={(preview) => void closeDevicePreview(preview)}
      />
    </section>
  );
}
