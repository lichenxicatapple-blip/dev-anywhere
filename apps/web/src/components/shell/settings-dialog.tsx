import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle2, Monitor, RefreshCw, Server, WifiOff } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type RelayHealthState =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; version: string; uptime: number }
  | { kind: "error"; message: string };

interface RelayHealthResponse {
  status?: string;
  version?: string;
  uptime?: number;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "未知";
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function healthUrl(relayUrl: string): string {
  const base = relayUrl || window.location.origin;
  return new URL("/health", base).toString();
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const selectedProxyName = useAppStore((s) => s.selectedProxyName);
  const relayUrl = useAppStore((s) => s.relayUrl);
  const [relayHealth, setRelayHealth] = useState<RelayHealthState>({ kind: "idle" });

  const loadRelayHealth = useCallback(
    async (signal?: AbortSignal) => {
      setRelayHealth({ kind: "loading" });
      try {
        const res = await fetch(healthUrl(relayUrl), {
          cache: "no-store",
          signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as RelayHealthResponse;
        if (body.status !== "ok") {
          throw new Error("状态异常");
        }
        setRelayHealth({
          kind: "ready",
          version: body.version ?? "未知",
          uptime: body.uptime ?? 0,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setRelayHealth({ kind: "error", message: err instanceof Error ? err.message : "读取失败" });
      }
    },
    [relayUrl],
  );

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    void loadRelayHealth(ctrl.signal);
    return () => ctrl.abort();
  }, [loadRelayHealth, open]);

  const relayVersion =
    relayHealth.kind === "ready"
      ? relayHealth.version
      : relayHealth.kind === "loading"
        ? "读取中..."
        : relayHealth.kind === "error"
          ? "读取失败"
          : "未读取";
  const relayDetail =
    relayHealth.kind === "ready"
      ? `运行 ${formatUptime(relayHealth.uptime)}`
      : relayHealth.kind === "error"
        ? relayHealth.message
        : "从当前 Relay /health 读取";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]" data-slot="settings-dialog">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            当前安装和连接状态。这里暂时只展示信息，不修改配置。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <SettingsRow
            icon={<Monitor className="size-4" aria-hidden="true" />}
            label="Web 版本"
            value={__APP_VERSION__}
            detail="当前浏览器加载的 DEV Anywhere Web"
          />
          <SettingsRow
            icon={<Server className="size-4" aria-hidden="true" />}
            label="Relay 版本"
            value={relayVersion}
            detail={relayDetail}
            muted={relayHealth.kind === "error"}
          />
          <SettingsRow
            icon={
              connected ? (
                <CheckCircle2 className="size-4" aria-hidden="true" />
              ) : (
                <WifiOff className="size-4" aria-hidden="true" />
              )
            }
            label="Relay 地址"
            value={relayUrl || "未初始化"}
            detail={connected ? "浏览器已连接 Relay" : "浏览器未连接 Relay"}
            muted={!connected}
          />
          <SettingsRow
            icon={<Monitor className="size-4" aria-hidden="true" />}
            label="开发机"
            value={selectedProxyName || "未选择"}
            detail={
              selectedProxyName
                ? proxyOnline
                  ? "当前开发机在线"
                  : "当前开发机离线"
                : "选择开发机后才能创建或接管会话"
            }
            muted={!selectedProxyName || !proxyOnline}
          />
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadRelayHealth()}
            disabled={relayHealth.kind === "loading"}
          >
            <RefreshCw
              className={cn("size-4", relayHealth.kind === "loading" && "animate-spin")}
              aria-hidden="true"
            />
            刷新版本
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  detail,
  muted = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  muted?: boolean;
}) {
  return (
    <div className="flex gap-3 rounded-md border border-border bg-card/70 p-3">
      <div
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
          muted
            ? "border-border text-muted-foreground"
            : "border-primary/35 bg-primary/10 text-primary",
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="min-w-0 truncate font-mono text-sm text-foreground">{value}</div>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}
