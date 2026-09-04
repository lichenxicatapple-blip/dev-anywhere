import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Cloud, Loader2, RefreshCw } from "lucide-react";
import type {
  TunnelProvider,
  WebPreviewCapability,
  WebPreviewSourceInput,
  WebPreviewTunnelStatus,
} from "@dev-anywhere/shared";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { usePreviewStore } from "@/stores/preview-store";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RemotePathSelector } from "@/components/path/remote-path-selector";
import { useMediaQuery } from "@/hooks/use-media-query";
import { readStorageValue, STORAGE_KEYS, writeStorageValue } from "@/lib/storage-keys";
import { cn } from "@/lib/utils";
import { createClientOperationId } from "@/lib/client-operation-id";
import { previewController } from "@/services/preview-controller";
import type { WebPreviewStaticInspection } from "@/types/web-preview";

interface CreateWebPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PreviewSourceKind = "local" | "static";
type InspectionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; path: string; result: WebPreviewStaticInspection };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TUNNEL_PROVIDER_META: Record<
  TunnelProvider,
  { label: string; executable: string; installUrl?: string }
> = {
  cloudflare: {
    label: "Cloudflare Tunnel",
    executable: "cloudflared",
    installUrl: "https://developers.cloudflare.com/tunnel/downloads/",
  },
  cpolar: { label: "Cpolar", executable: "cpolar" },
};

function loadTunnelProviderPreference(): TunnelProvider {
  return readStorageValue("local", STORAGE_KEYS.webPreviewTunnelProvider) === "cpolar"
    ? "cpolar"
    : "cloudflare";
}

function executableStatusForProvider(
  capability: WebPreviewCapability | null,
  provider: TunnelProvider,
): WebPreviewTunnelStatus | undefined {
  if (!capability) return undefined;
  return provider === "cloudflare" ? capability.cloudflared : capability.cpolar;
}

function providerAvailable(
  capability: WebPreviewCapability | null,
  provider: TunnelProvider,
): boolean {
  return executableStatusForProvider(capability, provider)?.available === true;
}

function validateLocalPreviewUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "请输入本机网站地址";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "请输入完整的 http:// 本机网站地址";
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return "只支持 localhost、127.0.0.1 或 [::1] 的 http:// 地址";
  }
  return null;
}

function resetInspection(): InspectionState {
  return { status: "idle" };
}

export function CreateWebPreviewDialog({ open, onOpenChange }: CreateWebPreviewDialogProps) {
  const [name, setName] = useState("");
  const [tunnelProvider, setTunnelProvider] = useState<TunnelProvider>(
    loadTunnelProviderPreference,
  );
  const [sourceKind, setSourceKind] = useState<PreviewSourceKind>("local");
  const [localUrl, setLocalUrl] = useState("");
  const [staticPath, setStaticPath] = useState("");
  const [selectedEntryPath, setSelectedEntryPath] = useState("");
  const [inspection, setInspection] = useState<InspectionState>(resetInspection);
  const [submitting, setSubmitting] = useState(false);
  const capabilityAbortRef = useRef<AbortController | null>(null);
  const inspectionAbortRef = useRef<AbortController | null>(null);
  const pendingCreateRef = useRef<{ sourceKey: string; operationId: string } | null>(null);
  const activeCreateOperationIdRef = useRef<string | null>(null);
  const tunnelProviderRef = useRef(tunnelProvider);
  tunnelProviderRef.current = tunnelProvider;
  const latestOpenRef = useRef(open);
  latestOpenRef.current = open;
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const selectedProxyId = useAppStore((state) => state.selectedProxyId);
  const capability = usePreviewStore((state) => state.capability);
  const capabilityStatus = usePreviewStore((state) => state.capabilityStatus);
  const capabilityError = usePreviewStore((state) => state.capabilityError);
  const previewScope = usePreviewStore((state) => state.authoritative?.scope ?? null);
  const previewScopeKey = previewScope
    ? `${previewScope.proxyId}\0${previewScope.bindingId}`
    : null;

  const selectTunnelProvider = useCallback((provider: TunnelProvider): void => {
    tunnelProviderRef.current = provider;
    setTunnelProvider(provider);
    writeStorageValue("local", STORAGE_KEYS.webPreviewTunnelProvider, provider);
  }, []);

  function resetForm(): void {
    setName("");
    setSourceKind("local");
    setLocalUrl("");
    setStaticPath("");
    setSelectedEntryPath("");
    setInspection(resetInspection());
    setSubmitting(false);
    capabilityAbortRef.current?.abort();
    capabilityAbortRef.current = null;
    inspectionAbortRef.current?.abort();
    inspectionAbortRef.current = null;
    pendingCreateRef.current = null;
    activeCreateOperationIdRef.current = null;
  }

  const detectCapability = useCallback(
    async (refreshPath: boolean): Promise<void> => {
      capabilityAbortRef.current?.abort();
      const abort = new AbortController();
      capabilityAbortRef.current = abort;
      const scope = previewController.getActiveScope();
      if (!scope || scope.proxyId !== selectedProxyId) {
        return;
      }
      try {
        const result = await previewController.requestWebPreviewCapability(scope, refreshPath, {
          signal: abort.signal,
        });
        if (!result || abort.signal.aborted || !latestOpenRef.current) {
          return;
        }
        if (!result.success) return;
        const selected = tunnelProviderRef.current;
        const fallback: TunnelProvider = selected === "cloudflare" ? "cpolar" : "cloudflare";
        if (
          !providerAvailable(result.capability, selected) &&
          providerAvailable(result.capability, fallback)
        ) {
          selectTunnelProvider(fallback);
        }
      } catch {
        // Capability failures are already reflected by the controller-owned store state.
      }
    },
    [selectTunnelProvider, selectedProxyId],
  );

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && submitting) return;
    onOpenChange(nextOpen);
  }

  useEffect(() => {
    if (!open) {
      resetForm();
      return;
    }
    void detectCapability(false);
    // Opening the dialog is the product-level capability probe. It intentionally reruns for every
    // open instead of trusting a possibly stale executable result from the previous attempt.
    return () => {
      capabilityAbortRef.current?.abort();
      capabilityAbortRef.current = null;
    };
  }, [detectCapability, open, previewScopeKey]);

  useEffect(() => {
    if (!open || sourceKind !== "static") return;
    inspectionAbortRef.current?.abort();
    inspectionAbortRef.current = null;
    const path = staticPath.trim();
    if (!path) {
      setInspection(resetInspection());
      setSelectedEntryPath("");
      return;
    }

    const abort = new AbortController();
    inspectionAbortRef.current = abort;
    setInspection({ status: "loading" });
    setSelectedEntryPath("");
    const timer = window.setTimeout(() => {
      const relay = relayClientRef;
      const scope = previewController.getActiveScope();
      if (!relay || !scope || scope.proxyId !== selectedProxyId) {
        setInspection({ status: "error", message: "请先连接开发机" });
        return;
      }
      void previewController
        .inspectStaticWebPreview(scope, path, { signal: abort.signal })
        .then((result) => {
          if (
            !result ||
            abort.signal.aborted ||
            !latestOpenRef.current ||
            !previewController.isActive(relay, scope)
          ) {
            return;
          }
          if (!result.success) {
            setInspection({
              status: "error",
              message: result.error,
            });
            return;
          }
          const htmlEntries = result.htmlEntries;
          if (htmlEntries.length === 0 && !result.entryPath) {
            setInspection({ status: "error", message: "这里没有可以预览的网页" });
            return;
          }
          const inspected: WebPreviewStaticInspection = {
            entryPath: result.entryPath,
            htmlEntries,
          };
          setInspection({ status: "ready", path, result: inspected });
          setSelectedEntryPath(result.entryPath ?? "");
        })
        .catch((error: unknown) => {
          if (
            abort.signal.aborted ||
            !latestOpenRef.current ||
            (error instanceof Error && error.name === "AbortError") ||
            !previewController.isActive(relay, scope)
          ) {
            return;
          }
          setInspection({
            status: "error",
            message: error instanceof Error ? error.message : "检查网页失败",
          });
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
      if (inspectionAbortRef.current === abort) inspectionAbortRef.current = null;
    };
  }, [open, previewScopeKey, selectedProxyId, sourceKind, staticPath]);

  const localUrlError = sourceKind === "local" ? validateLocalPreviewUrl(localUrl) : null;
  const staticReady =
    sourceKind === "static" &&
    inspection.status === "ready" &&
    inspection.path === staticPath.trim() &&
    !!(inspection.result.entryPath || selectedEntryPath);
  const capabilityReady =
    capabilityStatus === "loaded" && providerAvailable(capability, tunnelProvider);
  const formReady = sourceKind === "local" ? localUrlError === null : staticReady;
  const createDisabled = submitting || !capabilityReady || !formReady;

  async function handleSubmit(): Promise<void> {
    if (createDisabled) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }

    let source: WebPreviewSourceInput;
    if (sourceKind === "local") {
      source = { kind: "local", url: localUrl.trim() };
    } else {
      if (inspection.status !== "ready" || inspection.path !== staticPath.trim()) return;
      const entryPath = inspection.result.entryPath ?? selectedEntryPath;
      if (!entryPath) return;
      source = { kind: "static", path: inspection.path, entryPath };
    }

    setSubmitting(true);
    const scope = previewController.getActiveScope();
    if (!scope) {
      setSubmitting(false);
      toast.error("请先连接开发机");
      return;
    }
    let operationId: string | null = null;
    try {
      const customName = name.trim();
      const sourceKey = JSON.stringify({
        proxyId: scope.proxyId,
        tunnelProvider,
        source,
        name: customName || undefined,
      });
      if (pendingCreateRef.current?.sourceKey !== sourceKey) {
        pendingCreateRef.current = {
          sourceKey,
          operationId: createClientOperationId(`preview-operation-${tunnelProvider}`),
        };
      }
      operationId = pendingCreateRef.current.operationId;
      activeCreateOperationIdRef.current = operationId;
      const result = await previewController.createWebPreview(scope, source, {
        tunnelProvider,
        operationId,
        ...(customName ? { name: customName } : {}),
      });
      if (activeCreateOperationIdRef.current !== operationId) return;
      if (!result.accepted) {
        if (pendingCreateRef.current?.operationId === operationId) {
          pendingCreateRef.current = null;
        }
        toast.error(result.error);
        return;
      }
      if (pendingCreateRef.current?.operationId === operationId) {
        pendingCreateRef.current = null;
      }
      if (!latestOpenRef.current || !previewController.isActive(relay, scope)) return;
      onOpenChange(false);
    } catch (error) {
      if (!operationId || activeCreateOperationIdRef.current !== operationId) return;
      if (!latestOpenRef.current || !previewController.isActive(relay, scope)) return;
      toast.error(error instanceof Error ? error.message : "无法创建网页预览");
    } finally {
      if (operationId && activeCreateOperationIdRef.current === operationId) {
        activeCreateOperationIdRef.current = null;
        if (latestOpenRef.current) setSubmitting(false);
      }
    }
  }

  const form = (
    <form
      className="flex min-w-0 flex-col gap-4"
      data-slot="create-web-preview-form"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">名称（可选）</span>
        <input
          type="text"
          name="dev-anywhere-web-preview-name"
          value={name}
          maxLength={256}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={submitting}
          placeholder="自动生成"
          data-slot="web-preview-name"
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="min-h-11 min-w-0 rounded-md border border-border bg-input px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 md:h-9 md:min-h-0 md:text-sm"
        />
      </label>

      <section
        className="flex min-w-0 flex-col gap-1"
        data-slot="web-preview-tunnel-provider-field"
        data-provider={tunnelProvider}
      >
        <span className="text-sm">内网穿透服务</span>
        <Select
          value={tunnelProvider}
          disabled={submitting}
          onValueChange={(value) => selectTunnelProvider(value as TunnelProvider)}
        >
          <SelectTrigger
            aria-label="内网穿透服务"
            data-slot="web-preview-tunnel-provider-select"
            data-provider={tunnelProvider}
            className="min-h-11 w-full md:min-h-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-slot="web-preview-tunnel-provider-options">
            {(Object.keys(TUNNEL_PROVIDER_META) as TunnelProvider[]).map((provider) => (
              <SelectItem
                key={provider}
                value={provider}
                data-slot="web-preview-tunnel-provider-option"
                data-provider={provider}
              >
                {TUNNEL_PROVIDER_META[provider].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <CapabilityStatus
        status={capabilityStatus}
        capability={capability}
        provider={tunnelProvider}
        error={capabilityError}
        disabled={submitting}
        onRetry={() => void detectCapability(true)}
      />

      <section aria-label="网页来源" className="flex min-w-0 flex-col gap-2">
        <span className="text-sm">网页来源</span>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            data-slot="web-preview-source-local"
            disabled={submitting}
            aria-pressed={sourceKind === "local"}
            onClick={() => {
              inspectionAbortRef.current?.abort();
              inspectionAbortRef.current = null;
              setInspection(resetInspection());
              setSelectedEntryPath("");
              setSourceKind("local");
            }}
            className={cn(
              "flex min-h-16 min-w-0 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
              sourceKind === "local"
                ? "border-primary/70 bg-primary/10"
                : "border-border bg-muted/20",
            )}
          >
            <span className="text-sm font-medium">本机网站</span>
            <span className="text-xs text-muted-foreground">输入 localhost 地址</span>
          </button>
          <button
            type="button"
            data-slot="web-preview-source-static"
            disabled={submitting}
            aria-pressed={sourceKind === "static"}
            onClick={() => {
              inspectionAbortRef.current?.abort();
              inspectionAbortRef.current = null;
              setInspection(resetInspection());
              setSelectedEntryPath("");
              setSourceKind("static");
            }}
            className={cn(
              "flex min-h-16 min-w-0 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
              sourceKind === "static"
                ? "border-primary/70 bg-primary/10"
                : "border-border bg-muted/20",
            )}
          >
            <span className="text-sm font-medium">网页文件</span>
            <span className="text-xs text-muted-foreground">选择 HTML 网页文件或目录</span>
          </button>
        </div>
      </section>

      {sourceKind === "local" ? (
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-sm">本机网站地址</span>
          <input
            type="url"
            data-slot="web-preview-local-url"
            aria-label="本机网站地址"
            inputMode="url"
            name="dev-anywhere-preview-local-url"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={submitting}
            value={localUrl}
            onChange={(event) => {
              setLocalUrl(event.target.value);
            }}
            placeholder="http://localhost:5173"
            aria-invalid={localUrl.length > 0 && localUrlError !== null}
            className="min-h-11 min-w-0 rounded-md border border-border bg-input px-3 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 md:h-9 md:min-h-0 md:text-sm"
          />
          {localUrl.length > 0 && localUrlError ? (
            <span
              data-slot="web-preview-local-url-error"
              className="text-xs text-destructive"
              role="alert"
            >
              {localUrlError}
            </span>
          ) : null}
        </label>
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          <RemotePathSelector
            id="create-web-preview-path"
            name="dev-anywhere-preview-static-path"
            data-slot="web-preview-static-path"
            label="网页位置"
            value={staticPath}
            selectionKind="file-or-directory"
            fileExtensions={[".html", ".htm"]}
            disabled={submitting}
            placeholder="选择 HTML 网页文件或目录"
            onValueChange={setStaticPath}
          />
          <StaticInspectionStatus
            inspection={inspection}
            selectedEntryPath={selectedEntryPath}
            disabled={submitting}
            onEntryPathChange={(entryPath) => {
              setSelectedEntryPath(entryPath);
            }}
          />
        </div>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          data-slot="create-web-preview-cancel"
          className="min-h-11 md:min-h-0"
          onClick={() => handleOpenChange(false)}
          disabled={submitting}
        >
          取消
        </Button>
        <Button
          type="submit"
          className="min-h-11 md:min-h-0"
          disabled={createDisabled}
          data-slot="create-web-preview-submit"
        >
          {submitting ? "正在创建..." : "创建预览"}
        </Button>
      </DialogFooter>
    </form>
  );

  if (!isDesktop) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={!submitting}
          onEscapeKeyDown={(event) => {
            if (submitting) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (submitting) event.preventDefault();
          }}
          className="inset-x-2 max-h-[calc(100dvh-0.75rem)] w-auto overflow-x-hidden overflow-y-auto rounded-t-xl border bg-background px-4 pb-[max(theme(spacing.4),env(safe-area-inset-bottom))] pt-3"
          data-slot="create-web-preview-dialog"
          focusSurfaceOnOpen
        >
          <SheetHeader className="px-0 pb-1 pt-0 text-left">
            <SheetTitle>新建网页预览</SheetTitle>
            <SheetDescription>输入本机网站地址，或选择 HTML 网页文件或目录。</SheetDescription>
          </SheetHeader>
          {form}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!submitting}
        onEscapeKeyDown={(event) => {
          if (submitting) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (submitting) event.preventDefault();
        }}
        className="!w-[calc(100vw-2rem)] !max-w-none max-h-[calc(100dvh-2rem)] overflow-y-auto sm:!w-[40rem]"
        data-slot="create-web-preview-dialog"
        focusSurfaceOnOpen
      >
        <DialogHeader>
          <DialogTitle>新建网页预览</DialogTitle>
          <DialogDescription>输入本机网站地址，或选择 HTML 网页文件或目录。</DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}

function CapabilityStatus({
  status,
  capability,
  provider,
  error,
  disabled,
  onRetry,
}: {
  status: ReturnType<typeof usePreviewStore.getState>["capabilityStatus"];
  capability: ReturnType<typeof usePreviewStore.getState>["capability"];
  provider: TunnelProvider;
  error: string | null;
  disabled: boolean;
  onRetry: () => void;
}) {
  const providerMeta = TUNNEL_PROVIDER_META[provider];
  if (status === "loading" || status === "idle") {
    return (
      <div
        data-slot="web-preview-capability-status"
        data-status="loading"
        data-provider={provider}
        className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        正在检测 {providerMeta.label}...
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        data-slot="web-preview-capability-status"
        data-status="error"
        data-provider={provider}
        className="rounded-md border border-destructive/45 bg-destructive/5 p-3"
        role="alert"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">无法检测 {providerMeta.label}</p>
            {error ? (
              <p className="mt-1 break-words text-xs text-muted-foreground">{error}</p>
            ) : null}
          </div>
          <RetryButton onClick={onRetry} disabled={disabled} />
        </div>
      </div>
    );
  }

  const executableStatus = executableStatusForProvider(capability, provider);
  if (!executableStatus?.available) {
    const suggestions = executableStatus?.suggestions ?? [];
    const missingHeading = `未找到 ${providerMeta.label}`;
    const errorDiffersFromHeading =
      executableStatus?.error && executableStatus.error !== missingHeading;
    return (
      <div
        data-slot="web-preview-capability-status"
        data-status="missing"
        data-provider={provider}
        className="rounded-md border border-[var(--color-status-warning)]/45 bg-[var(--color-status-warning)]/5 p-3"
        role="alert"
      >
        <div className="flex items-start gap-2">
          <Cloud
            className="mt-0.5 size-4 shrink-0 text-[var(--color-status-warning)]"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{missingHeading}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              请先安装 {providerMeta.executable}，并确保它在用户 Shell 的 PATH 中，然后重新检测。
            </p>
            {suggestions.length > 0 ? (
              <div className="mt-2 text-xs text-muted-foreground">
                <span>检测到的位置：</span>
                <ul className="mt-1 space-y-1">
                  {suggestions.map((suggestion) => (
                    <li
                      key={suggestion}
                      data-slot={
                        provider === "cloudflare"
                          ? "web-preview-cloudflared-suggestion"
                          : "web-preview-cpolar-suggestion"
                      }
                      data-provider={provider}
                      data-path={suggestion}
                    >
                      <code className="break-all rounded bg-muted px-1 py-0.5">{suggestion}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {providerMeta.installUrl ? (
              <a
                data-slot="web-preview-cloudflared-install-link"
                data-provider={provider}
                href={providerMeta.installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs text-primary underline-offset-4 hover:underline"
              >
                查看官方安装说明
              </a>
            ) : null}
            {errorDiffersFromHeading ? (
              <p className="mt-1 break-words text-xs text-muted-foreground/80">
                {executableStatus.error}
              </p>
            ) : null}
          </div>
          <RetryButton onClick={onRetry} disabled={disabled} />
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="web-preview-capability-status"
      data-status="ready"
      data-provider={provider}
      className="flex items-center gap-2 rounded-md border border-[var(--color-status-success)]/35 bg-[var(--color-status-success)]/5 px-3 py-2 text-sm"
      role="status"
    >
      <CheckCircle2 className="size-4 text-[var(--color-status-success)]" aria-hidden="true" />
      <span>{providerMeta.label} 已安装</span>
      {executableStatus.version ? (
        <span className="truncate text-xs text-muted-foreground">· {executableStatus.version}</span>
      ) : null}
    </div>
  );
}

function RetryButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-slot="web-preview-capability-retry"
      className="shrink-0"
      onClick={onClick}
      disabled={disabled}
    >
      <RefreshCw className="size-3.5" aria-hidden="true" />
      重新检测
    </Button>
  );
}

function StaticInspectionStatus({
  inspection,
  selectedEntryPath,
  disabled,
  onEntryPathChange,
}: {
  inspection: InspectionState;
  selectedEntryPath: string;
  disabled: boolean;
  onEntryPathChange: (entryPath: string) => void;
}) {
  if (inspection.status === "idle") return null;
  if (inspection.status === "loading") {
    return (
      <span
        data-slot="web-preview-static-inspection"
        data-status="loading"
        className="flex items-center gap-2 text-xs text-muted-foreground"
        role="status"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        正在检查网页...
      </span>
    );
  }
  if (inspection.status === "error") {
    return (
      <span
        data-slot="web-preview-static-inspection"
        data-status="error"
        className="text-xs text-destructive"
        role="alert"
      >
        {inspection.message}
      </span>
    );
  }

  const requiresChoice = !inspection.result.entryPath && inspection.result.htmlEntries.length > 1;
  if (requiresChoice) {
    return (
      <label
        data-slot="web-preview-static-inspection"
        data-status="choose-entry"
        className="mt-1 flex min-w-0 flex-col gap-2"
      >
        <span className="text-sm">这个文件夹里有多个网页，打开预览时先显示哪个？</span>
        <Select value={selectedEntryPath} onValueChange={onEntryPathChange} disabled={disabled}>
          <SelectTrigger data-slot="web-preview-entry-select" className="w-full font-mono">
            <SelectValue placeholder="选择网页" />
          </SelectTrigger>
          <SelectContent>
            {inspection.result.htmlEntries.map((entry) => (
              <SelectItem key={entry} value={entry} data-entry-path={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  }

  const entryPath = inspection.result.entryPath;
  return entryPath ? (
    <span
      data-slot="web-preview-static-inspection"
      data-status="ready"
      data-entry-path={entryPath}
      className="truncate text-xs text-muted-foreground"
      title={entryPath}
    >
      打开时显示：<span className="font-mono">{entryPath}</span>
    </span>
  ) : null;
}
