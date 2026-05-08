import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight, Monitor, Server } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

type SettingsView = "menu" | "version";

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
  const relayUrl = useAppStore((s) => s.relayUrl);
  const [view, setView] = useState<SettingsView>("menu");
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
        setRelayHealth({
          kind: "error",
          message: err instanceof Error ? "当前 Relay 无法读取版本" : "读取失败",
        });
      }
    },
    [relayUrl],
  );

  useEffect(() => {
    if (!open) {
      setView("menu");
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || view !== "version") return;
    const ctrl = new AbortController();
    void loadRelayHealth(ctrl.signal);
    return () => ctrl.abort();
  }, [loadRelayHealth, open, view]);

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
      <DialogContent
        className="sm:max-w-[440px]"
        data-slot="settings-dialog"
        showCloseButton={view === "menu"}
      >
        <DialogHeader>
          {view === "version" ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-ml-2 size-9"
                aria-label="返回设置"
                onClick={() => setView("menu")}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </Button>
              <div className="space-y-2">
                <DialogTitle>版本</DialogTitle>
                <DialogDescription>当前 Web 与 Relay 的版本信息。</DialogDescription>
              </div>
            </div>
          ) : (
            <>
              <DialogTitle>设置</DialogTitle>
              <DialogDescription>选择要查看或调整的项目。</DialogDescription>
            </>
          )}
        </DialogHeader>

        {view === "version" ? (
          <div className="space-y-3">
            <VersionRow
              icon={<Monitor className="size-4" aria-hidden="true" />}
              label="Web"
              value={__APP_VERSION__}
              detail="当前浏览器加载的版本"
            />
            <VersionRow
              icon={<Server className="size-4" aria-hidden="true" />}
              label="Relay"
              value={relayVersion}
              detail={relayDetail}
              muted={relayHealth.kind === "error"}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <SettingsMenuItem
              icon={<Server className="size-4" aria-hidden="true" />}
              label="版本"
              detail="查看 Web 和 Relay 版本"
              onClick={() => setView("version")}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsMenuItem({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-md border border-border bg-card/70 p-3 text-left transition-colors hover:border-primary/45 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      onClick={onClick}
      data-slot="settings-menu-item"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/35 bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

function VersionRow({
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
