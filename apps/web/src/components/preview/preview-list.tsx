import { useEffect, useState } from "react";
import type { DevicePreviewSummary, PreviewSummary } from "@dev-anywhere/shared";
import { useMatch, useNavigate } from "react-router";
import { toast } from "@/components/toast";
import { listPreviewPendingOperationsForPreview } from "@/services/preview-pending-operations";
import { previewController } from "@/services/preview-controller";
import { samePreviewScope, type PreviewScope } from "@/services/preview-scope";
import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { usePreviewOperationStore } from "@/stores/preview-operation-store";
import { usePreviewStore } from "@/stores/preview-store";
import { DevicePreviewCloseDialog } from "./device-preview-close-dialog";
import { DevicePreviewRow } from "./device-preview-row";
import { PreviewCloseDialog } from "./preview-close-dialog";
import { PreviewRenameDialog } from "./preview-rename-dialog";
import { PreviewRow } from "./preview-row";

interface PreviewDialogTarget {
  readonly kind: "web" | "device";
  readonly previewId: string;
  readonly scope: PreviewScope;
}

const NO_WEB_PREVIEWS: readonly PreviewSummary[] = Object.freeze([]);
const NO_DEVICE_PREVIEWS: readonly DevicePreviewSummary[] = Object.freeze([]);

function createDialogTarget(
  kind: PreviewDialogTarget["kind"],
  previewId: string,
  scope: PreviewScope,
): PreviewDialogTarget {
  return Object.freeze({
    kind,
    previewId,
    scope: Object.freeze({ proxyId: scope.proxyId, bindingId: scope.bindingId }),
  });
}

function sameDialogTarget(left: PreviewDialogTarget | null, right: PreviewDialogTarget): boolean {
  return (
    left !== null &&
    left.kind === right.kind &&
    left.previewId === right.previewId &&
    samePreviewScope(left.scope, right.scope)
  );
}

function scopeMatchesTarget(
  target: PreviewDialogTarget,
  activeScope: PreviewScope | null,
  authoritativeScope: PreviewScope | undefined,
): boolean {
  return (
    activeScope !== null &&
    authoritativeScope !== undefined &&
    samePreviewScope(target.scope, activeScope) &&
    samePreviewScope(target.scope, authoritativeScope)
  );
}

function targetStillExists(target: PreviewDialogTarget): boolean {
  const activeScope = previewController.getActiveScope();
  const authoritative =
    target.kind === "web"
      ? usePreviewStore.getState().authoritative
      : useDevicePreviewStore.getState().authoritative;
  if (!authoritative || !scopeMatchesTarget(target, activeScope, authoritative.scope)) return false;
  return authoritative.previews.some((preview) => preview.previewId === target.previewId);
}

function scopeIsStillActive(scope: PreviewScope): boolean {
  const current = previewController.getActiveScope();
  return current !== null && samePreviewScope(current, scope);
}

export function PreviewList() {
  const webAuthoritative = usePreviewStore((state) => state.authoritative);
  const deviceAuthoritative = useDevicePreviewStore((state) => state.authoritative);
  const operationRegistry = usePreviewOperationStore((state) => state.registry);
  const activeScope = previewController.getActiveScope();
  const webScope =
    activeScope && webAuthoritative && samePreviewScope(activeScope, webAuthoritative.scope)
      ? webAuthoritative.scope
      : null;
  const deviceScope =
    activeScope && deviceAuthoritative && samePreviewScope(activeScope, deviceAuthoritative.scope)
      ? deviceAuthoritative.scope
      : null;
  const previews = webScope && webAuthoritative ? webAuthoritative.previews : NO_WEB_PREVIEWS;
  const devicePreviews =
    deviceScope && deviceAuthoritative ? deviceAuthoritative.previews : NO_DEVICE_PREVIEWS;
  const deviceMatch = useMatch("/preview/device/:id");
  const navigate = useNavigate();
  const [pendingClose, setPendingClose] = useState<PreviewDialogTarget | null>(null);
  const [pendingRename, setPendingRename] = useState<PreviewDialogTarget | null>(null);

  const pendingRenameWebPreview =
    pendingRename?.kind === "web" &&
    scopeMatchesTarget(pendingRename, activeScope, webAuthoritative?.scope)
      ? (previews.find((preview) => preview.previewId === pendingRename.previewId) ?? null)
      : null;
  const pendingRenameDevicePreview =
    pendingRename?.kind === "device" &&
    scopeMatchesTarget(pendingRename, activeScope, deviceAuthoritative?.scope)
      ? (devicePreviews.find((preview) => preview.previewId === pendingRename.previewId) ?? null)
      : null;
  const pendingRenamePreview = pendingRenameWebPreview ?? pendingRenameDevicePreview;
  const pendingWebClosePreview =
    pendingClose?.kind === "web" &&
    scopeMatchesTarget(pendingClose, activeScope, webAuthoritative?.scope)
      ? (previews.find((preview) => preview.previewId === pendingClose.previewId) ?? null)
      : null;
  const pendingDeviceClosePreview =
    pendingClose?.kind === "device" &&
    scopeMatchesTarget(pendingClose, activeScope, deviceAuthoritative?.scope)
      ? (devicePreviews.find((preview) => preview.previewId === pendingClose.previewId) ?? null)
      : null;

  useEffect(() => {
    if (pendingRename && !pendingRenamePreview) {
      setPendingRename((current) => (sameDialogTarget(current, pendingRename) ? null : current));
    }
    if (pendingClose && !pendingWebClosePreview && !pendingDeviceClosePreview) {
      setPendingClose((current) => (sameDialogTarget(current, pendingClose) ? null : current));
    }
  }, [
    pendingClose,
    pendingDeviceClosePreview,
    pendingRename,
    pendingRenamePreview,
    pendingWebClosePreview,
  ]);

  function pendingOperation(
    scope: PreviewScope,
    previewKind: "web" | "device",
    previewId: string,
  ): "rename" | "reconnect" | "close" | undefined {
    return listPreviewPendingOperationsForPreview(
      operationRegistry,
      scope,
      previewKind,
      previewId,
    )[0]?.kind;
  }

  if (previews.length === 0 && devicePreviews.length === 0) return null;

  async function reconnectPreview(target: PreviewDialogTarget): Promise<void> {
    if (!targetStillExists(target)) return;
    try {
      const result = await previewController.reconnectWebPreview(target.scope, target.previewId);
      if (!scopeIsStillActive(target.scope)) return;
      if (!result.success) toast.error(result.error);
    } catch (error) {
      if (!scopeIsStillActive(target.scope)) return;
      toast.error(error instanceof Error ? error.message : "无法重新连接网页预览");
    }
  }

  async function renamePreview(target: PreviewDialogTarget, name: string): Promise<void> {
    if (!targetStillExists(target)) return;

    let result: Awaited<ReturnType<typeof previewController.renameWebPreview>>;
    try {
      result =
        target.kind === "web"
          ? await previewController.renameWebPreview(target.scope, target.previewId, name)
          : await previewController.renameDevicePreview(target.scope, target.previewId, name);
    } catch (error) {
      if (!scopeIsStillActive(target.scope)) return;
      throw error;
    }
    if (!scopeIsStillActive(target.scope)) return;
    if (result.success) return;

    throw new Error(result.error);
  }

  async function closePreview(target: PreviewDialogTarget): Promise<void> {
    if (!targetStillExists(target)) return;
    try {
      const result = await previewController.closeWebPreview(target.scope, target.previewId);
      if (!scopeIsStillActive(target.scope)) return;
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setPendingClose((current) => (sameDialogTarget(current, target) ? null : current));
    } catch (error) {
      if (!scopeIsStillActive(target.scope)) return;
      toast.error(error instanceof Error ? error.message : "无法关闭网页预览");
    }
  }

  async function reconnectDevicePreview(target: PreviewDialogTarget): Promise<void> {
    if (!targetStillExists(target)) return;
    try {
      const result = await previewController.reconnectDevicePreview(target.scope, target.previewId);
      if (!scopeIsStillActive(target.scope)) return;
      if (!result.success) toast.error(result.error);
    } catch (error) {
      if (!scopeIsStillActive(target.scope)) return;
      toast.error(error instanceof Error ? error.message : "无法重新连接模拟器预览");
    }
  }

  async function closeDevicePreview(target: PreviewDialogTarget): Promise<void> {
    if (!targetStillExists(target)) return;
    try {
      const result = await previewController.closeDevicePreview(target.scope, target.previewId);
      if (!scopeIsStillActive(target.scope)) return;
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setPendingClose((current) => (sameDialogTarget(current, target) ? null : current));
      if (deviceMatch?.params.id === target.previewId) navigate("/sessions");
    } catch (error) {
      if (!scopeIsStillActive(target.scope)) return;
      toast.error(error instanceof Error ? error.message : "无法停止模拟器预览");
    }
  }

  const pendingWebClose =
    pendingClose?.kind === "web" &&
    pendingOperation(pendingClose.scope, "web", pendingClose.previewId) === "close";
  const pendingDeviceCloseOperation =
    pendingClose?.kind === "device" &&
    pendingOperation(pendingClose.scope, "device", pendingClose.previewId) === "close";

  const renameTarget = pendingRename;
  const closeTarget = pendingClose;

  return (
    <section data-slot="preview-section" aria-labelledby="preview-section-title">
      <h3
        id="preview-section-title"
        className="px-4 pb-2 pt-3 text-sm font-semibold text-foreground"
      >
        预览
        <span className="ml-1 font-normal text-muted-foreground/70">
          · {previews.length + devicePreviews.length}
        </span>
      </h3>
      <ul role="list" className="flex w-full min-w-0 flex-col">
        {previews.map((preview) => (
          <PreviewRow
            key={preview.previewId}
            preview={preview}
            pendingOperation={
              webScope ? pendingOperation(webScope, "web", preview.previewId) : undefined
            }
            onRename={() =>
              webScope && setPendingRename(createDialogTarget("web", preview.previewId, webScope))
            }
            onReconnect={() =>
              webScope &&
              void reconnectPreview(createDialogTarget("web", preview.previewId, webScope))
            }
            onClose={() =>
              webScope && setPendingClose(createDialogTarget("web", preview.previewId, webScope))
            }
          />
        ))}
        {devicePreviews.map((preview) => (
          <DevicePreviewRow
            key={preview.previewId}
            preview={preview}
            selected={deviceMatch?.params.id === preview.previewId}
            pendingOperation={
              deviceScope ? pendingOperation(deviceScope, "device", preview.previewId) : undefined
            }
            onRename={() =>
              deviceScope &&
              setPendingRename(createDialogTarget("device", preview.previewId, deviceScope))
            }
            onReconnect={() =>
              deviceScope &&
              void reconnectDevicePreview(
                createDialogTarget("device", preview.previewId, deviceScope),
              )
            }
            onClose={() =>
              deviceScope &&
              setPendingClose(createDialogTarget("device", preview.previewId, deviceScope))
            }
          />
        ))}
      </ul>
      <PreviewRenameDialog
        target={
          renameTarget && pendingRenamePreview
            ? {
                targetKey: `${renameTarget.kind}\0${renameTarget.scope.proxyId}\0${renameTarget.scope.bindingId}\0${renameTarget.previewId}`,
                name: pendingRenamePreview.name,
              }
            : null
        }
        onOpenChange={(open) => {
          if (!open && renameTarget) {
            setPendingRename((current) =>
              sameDialogTarget(current, renameTarget) ? null : current,
            );
          }
        }}
        onRename={(name) => (renameTarget ? renamePreview(renameTarget, name) : Promise.resolve())}
      />
      <PreviewCloseDialog
        preview={pendingWebClosePreview}
        closing={pendingWebClose}
        onOpenChange={(open) => {
          if (!open && !pendingWebClose && closeTarget) {
            setPendingClose((current) => (sameDialogTarget(current, closeTarget) ? null : current));
          }
        }}
        onConfirm={() => closeTarget && void closePreview(closeTarget)}
      />
      <DevicePreviewCloseDialog
        preview={pendingDeviceClosePreview}
        closing={pendingDeviceCloseOperation}
        onOpenChange={(open) => {
          if (!open && !pendingDeviceCloseOperation && closeTarget) {
            setPendingClose((current) => (sameDialogTarget(current, closeTarget) ? null : current));
          }
        }}
        onConfirm={() => closeTarget && void closeDevicePreview(closeTarget)}
      />
    </section>
  );
}
