import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, RefreshCw, Smartphone } from "lucide-react";
import type {
  DevicePreviewPlatform,
  DevicePreviewTarget,
  DevicePreviewToolStatus,
} from "@dev-anywhere/shared";
import { useNavigate } from "react-router";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { selectDevicePreviews, useDevicePreviewStore } from "@/stores/device-preview-store";
import { useAppStore } from "@/stores/app-store";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { createClientOperationId } from "@/lib/client-operation-id";
import { previewController } from "@/services/preview-controller";

interface CreateDevicePreviewDialogProps {
  open: boolean;
  platform: DevicePreviewPlatform;
  onOpenChange: (open: boolean) => void;
}

const PLATFORM_LABEL: Record<DevicePreviewPlatform, string> = {
  ios: "iOS Simulator",
  android: "Android Emulator",
};

export function CreateDevicePreviewDialog({
  open,
  platform,
  onOpenChange,
}: CreateDevicePreviewDialogProps) {
  const navigate = useNavigate();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const selectedProxyId = useAppStore((state) => state.selectedProxyId);
  const capability = useDevicePreviewStore((state) => state.capability);
  const targets = useDevicePreviewStore((state) => state.targets);
  const targetsStatus = useDevicePreviewStore((state) => state.targetsStatus);
  const targetsError = useDevicePreviewStore((state) => state.targetsError);
  const previews = useDevicePreviewStore(selectDevicePreviews);
  const previewScope = useDevicePreviewStore((state) => state.authoritative?.scope ?? null);
  const previewScopeKey = previewScope
    ? `${previewScope.proxyId}\0${previewScope.bindingId}`
    : null;
  const [name, setName] = useState("");
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const detectionAbortRef = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const operationRef = useRef<{
    proxyId: string;
    targetId: string;
    name: string;
    operationId: string;
  } | null>(null);
  const activeCreateOperationIdRef = useRef<string | null>(null);

  const platformTargets = useMemo(
    () => targets.filter((target) => target.platform === platform),
    [platform, targets],
  );
  const occupiedTargetIds = useMemo(
    () => new Set(previews.map((preview) => preview.targetId)),
    [previews],
  );
  const selectableTargets = useMemo(
    () => platformTargets.filter((target) => !occupiedTargetIds.has(target.targetId)),
    [occupiedTargetIds, platformTargets],
  );
  const selectedTarget = selectableTargets.find((target) => target.targetId === selectedTargetId);
  const tool = capability?.[platform];

  const detect = useCallback(
    async (refreshPath: boolean): Promise<void> => {
      detectionAbortRef.current?.abort();
      const abort = new AbortController();
      detectionAbortRef.current = abort;
      const relay = relayClientRef;
      const scope = previewController.getActiveScope();
      if (!relay || !scope || scope.proxyId !== selectedProxyId) {
        return;
      }
      try {
        // Capability refresh may configure the backend, so target discovery must run afterwards.
        const capabilityResult = await previewController.requestDevicePreviewCapability(
          scope,
          refreshPath,
          { signal: abort.signal },
        );
        if (!capabilityResult || abort.signal.aborted || !openRef.current) return;
        if (!capabilityResult.success) return;
        await previewController.requestDevicePreviewTargets(scope, true, {
          signal: abort.signal,
        });
      } catch {
        // Capability/target failures are already reflected by the controller-owned store state.
      }
    },
    [selectedProxyId],
  );

  useEffect(() => {
    if (!open) {
      detectionAbortRef.current?.abort();
      detectionAbortRef.current = null;
      setName("");
      setSelectedTargetId(null);
      setSubmitting(false);
      operationRef.current = null;
      activeCreateOperationIdRef.current = null;
      return;
    }
    void detect(false);
    return () => {
      detectionAbortRef.current?.abort();
      detectionAbortRef.current = null;
    };
  }, [detect, open, platform, previewScopeKey]);

  useEffect(() => {
    if (!open) return;
    if (selectedTargetId && !selectedTarget) {
      setSelectedTargetId(null);
      return;
    }
    if (!selectedTargetId && selectableTargets.length === 1) {
      setSelectedTargetId(selectableTargets[0]!.targetId);
    }
  }, [open, selectableTargets, selectedTarget, selectedTargetId]);

  async function submit(): Promise<void> {
    const target = selectedTarget;
    if (!target || submitting || tool?.available !== true) return;
    const relay = relayClientRef;
    const scope = previewController.getActiveScope();
    if (!relay || !scope || scope.proxyId !== selectedProxyId) {
      toast.error("请先连接开发机");
      return;
    }
    setSubmitting(true);
    let operationId: string | null = null;
    try {
      const customName = name.trim();
      const operation =
        operationRef.current?.proxyId === scope.proxyId &&
        operationRef.current.targetId === target.targetId &&
        operationRef.current.name === customName
          ? operationRef.current
          : {
              proxyId: scope.proxyId,
              targetId: target.targetId,
              name: customName,
              operationId: createClientOperationId("device-preview-operation"),
            };
      operationRef.current = operation;
      operationId = operation.operationId;
      activeCreateOperationIdRef.current = operationId;
      const result = await previewController.createDevicePreview(scope, target.targetId, {
        operationId: operation.operationId,
        ...(customName ? { name: customName } : {}),
      });
      if (activeCreateOperationIdRef.current !== operation.operationId) return;
      if (!result.accepted) {
        if (operationRef.current?.operationId === operation.operationId) {
          operationRef.current = null;
        }
        if (!openRef.current || !previewController.isActive(relay, scope)) return;
        toast.error(result.error);
        return;
      }
      if (operationRef.current?.operationId === operation.operationId) {
        operationRef.current = null;
      }
      if (!openRef.current || !previewController.isActive(relay, scope)) return;
      onOpenChange(false);
      navigate(`/preview/device/${result.previewId}`);
    } catch (error) {
      if (!operationId || activeCreateOperationIdRef.current !== operationId) return;
      if (!openRef.current || !previewController.isActive(relay, scope)) return;
      toast.error(error instanceof Error ? error.message : "无法创建模拟器预览");
    } finally {
      if (operationId && activeCreateOperationIdRef.current === operationId) {
        activeCreateOperationIdRef.current = null;
        if (openRef.current) setSubmitting(false);
      }
    }
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && submitting) return;
    if (!nextOpen) {
      detectionAbortRef.current?.abort();
      detectionAbortRef.current = null;
      operationRef.current = null;
      activeCreateOperationIdRef.current = null;
      setName("");
      setSelectedTargetId(null);
    }
    onOpenChange(nextOpen);
  }

  const content = (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">名称（可选）</span>
        <input
          type="text"
          name="dev-anywhere-device-preview-name"
          value={name}
          maxLength={256}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={submitting}
          placeholder="自动生成"
          data-slot="device-preview-name"
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="min-h-11 min-w-0 rounded-md border border-border bg-input px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 md:h-9 md:min-h-0 md:text-sm"
        />
      </label>
      <DeviceToolStatus platform={platform} tool={tool} />
      <div className="grid min-w-0 grid-cols-1 gap-2" data-slot="device-preview-targets">
        {targetsStatus === "loading" ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            正在查找已启动的模拟器...
          </div>
        ) : targetsStatus === "error" ? (
          <StatusMessage message={targetsError ?? "无法读取模拟器列表"} />
        ) : platformTargets.length === 0 ? (
          <StatusMessage message={`没有已启动的 ${PLATFORM_LABEL[platform]}`} />
        ) : (
          platformTargets.map((target) => {
            const selected = target.targetId === selectedTargetId;
            const alreadyOpen = occupiedTargetIds.has(target.targetId);
            return (
              <TargetButton
                key={target.targetId}
                target={target}
                selected={selected}
                disabled={alreadyOpen || submitting}
                alreadyOpen={alreadyOpen}
                onClick={() => {
                  setSelectedTargetId(target.targetId);
                }}
              />
            );
          })
        )}
      </div>
      <DialogFooter className="gap-2 sm:gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={submitting || targetsStatus === "loading"}
          onClick={() => void detect(true)}
          data-slot="device-preview-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          重新检测
        </Button>
        <Button
          type="button"
          disabled={!selectedTarget || submitting || tool?.available !== true}
          onClick={() => void submit()}
          data-slot="create-device-preview-submit"
        >
          {submitting ? "正在创建..." : "创建预览"}
        </Button>
      </DialogFooter>
    </div>
  );

  const title = `新建 ${PLATFORM_LABEL[platform]} 预览`;
  const description = "选择开发机上已经启动的模拟器。";

  if (!isDesktop) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={!submitting}
          className="inset-x-2 max-h-[calc(100dvh-0.75rem)] w-auto min-w-0 max-w-[calc(100%-1rem)] overflow-x-hidden overflow-y-auto rounded-t-xl border bg-background px-4 pb-[max(theme(spacing.4),env(safe-area-inset-bottom))] pt-3"
          data-slot="create-device-preview-dialog"
          data-platform={platform}
          focusSurfaceOnOpen
        >
          <SheetHeader className="px-0 pb-1 pt-0 text-left">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          {content}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!submitting}
        className="sm:max-w-xl"
        data-slot="create-device-preview-dialog"
        data-platform={platform}
        focusSurfaceOnOpen
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

function DeviceToolStatus({
  platform,
  tool,
}: {
  platform: DevicePreviewPlatform;
  tool: DevicePreviewToolStatus | undefined;
}) {
  if (!tool || tool.available) return null;
  const name = platform === "ios" ? "Baguette" : "Scrcpy";
  const status = !tool.supported
    ? "unsupported"
    : platform === "ios" && tool.version
      ? "outdated"
      : tool.command
        ? "unavailable"
        : "missing";
  const title =
    status === "unsupported"
      ? `${PLATFORM_LABEL[platform]} 不可用`
      : status === "outdated"
        ? `需要更新 ${name}`
        : status === "unavailable"
          ? `${name} 暂时不可用`
          : `未找到 ${name}`;
  const description =
    tool.error ??
    (platform === "ios"
      ? "需要先在开发机上安装 Baguette 0.1.96 或更高版本。"
      : "需要先在开发机上安装 Scrcpy 4.1。");
  const showDescription = description.trim() !== title.trim();
  return (
    <div
      className="rounded-lg border border-amber-500/45 bg-amber-500/5 p-3 text-sm"
      data-slot="device-preview-tool-status"
      data-status={status}
    >
      <div className="flex gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          {showDescription ? (
            <p className="mt-1 text-muted-foreground" data-slot="device-preview-tool-description">
              {description}
            </p>
          ) : null}
          {status !== "unsupported" ? (
            <a
              href={
                platform === "ios"
                  ? "https://github.com/tddworks/baguette#install"
                  : "https://github.com/Genymobile/scrcpy"
              }
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-primary underline underline-offset-4"
            >
              查看安装方法
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusMessage({ message }: { message: string }) {
  return (
    <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function TargetButton({
  target,
  selected,
  disabled,
  alreadyOpen,
  onClick,
}: {
  target: DevicePreviewTarget;
  selected: boolean;
  disabled: boolean;
  alreadyOpen: boolean;
  onClick: () => void;
}) {
  const platformLabel = target.platform === "ios" ? "iOS" : "Android";
  const detail = `${target.model} · ${platformLabel} ${target.osVersion}`;
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-16 w-full min-w-0 max-w-full items-center gap-3 overflow-hidden rounded-lg border px-3 py-2 text-left outline-none transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
        disabled && "cursor-not-allowed opacity-55",
      )}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      data-slot="device-preview-target"
      data-target-id={target.targetId}
      data-already-open={alreadyOpen ? "true" : "false"}
      data-interactive={target.interactive ? "true" : "false"}
    >
      <Smartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{target.name}</span>
        <span
          className="mt-0.5 block truncate text-xs text-muted-foreground"
          data-slot="device-preview-target-device"
          data-device-model={target.model}
          data-os-version={target.osVersion}
        >
          {detail}
        </span>
      </span>
      {alreadyOpen ? (
        <span className="text-xs text-muted-foreground">已在预览</span>
      ) : selected ? (
        <Check className="size-4 text-primary" aria-hidden="true" />
      ) : null}
    </button>
  );
}
