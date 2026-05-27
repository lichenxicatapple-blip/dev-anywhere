import { useCallback, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { Activity, ArrowLeft, AudioLines, ChevronRight, Monitor, Server } from "lucide-react";
import packageInfo from "../../../package.json" with { type: "json" };
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { VoiceSettingsPanel } from "@/components/shell/voice-settings-panel";
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

type SettingsView = "menu" | "version" | "voice";

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
  const latencyMonitorEnabled = useAppStore((s) => s.latencyMonitorEnabled);
  const setLatencyMonitorEnabled = useAppStore((s) => s.setLatencyMonitorEnabled);
  const desktopInteractionMode = useAppStore((s) => s.desktopInteractionMode);
  const setDesktopInteractionMode = useAppStore((s) => s.setDesktopInteractionMode);
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

  useEffect(() => {
    if (!open || view !== "voice") return;
    const frame = window.requestAnimationFrame(() => {
      const voiceDialog = document.querySelector<HTMLElement>(
        '[data-slot="settings-dialog"][data-view="voice"]',
      );
      voiceDialog
        ?.querySelector<HTMLButtonElement>('[data-slot="voice-settings-back"]')
        ?.focus({ preventScroll: true });
      const scroller = voiceDialog?.querySelector<HTMLElement>(
        '[data-slot="voice-settings-scroll"]',
      );
      if (scroller) scroller.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, view]);

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
        className={cn(
          "grid max-h-[calc(100dvh-1rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-4 sm:max-w-[440px] sm:p-6",
          view === "voice" && "max-h-[min(760px,calc(100dvh-1rem))] !gap-0 !p-0 sm:max-w-[480px]",
          view === "voice" &&
            "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:h-[calc(100dvh-0.75rem)] max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:border-x-0 max-sm:border-b-0",
        )}
        data-slot="settings-dialog"
        data-view={view}
        showCloseButton={view === "menu"}
      >
        <DialogHeader
          className={cn(
            view === "menu" && "pr-12 text-left",
            view === "voice" && "gap-0 px-4 pb-0 pt-3.5 text-left sm:px-5 sm:pt-4",
          )}
        >
          {view !== "menu" ? (
            <>
              <div className="flex items-start gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-ml-2 mt-0.5 size-9"
                  aria-label="返回设置"
                  data-slot="voice-settings-back"
                  onClick={() => setView("menu")}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                </Button>
                <div className="min-w-0 space-y-1.5 pt-0.5">
                  <DialogTitle>{view === "version" ? "版本" : "设置 Voice Pilot"}</DialogTitle>
                  <DialogDescription className={cn(view === "voice" && "max-w-[28rem] leading-5")}>
                    {view === "version"
                      ? "当前 Web 与 Relay 的版本信息"
                      : "连接语音服务后，即可以语音交互的形式驱动会话。"}
                  </DialogDescription>
                </div>
              </div>
              {view === "voice" ? (
                <div
                  className="mr-4 mt-3.5 border-t border-border/70"
                  data-slot="voice-settings-header-divider"
                />
              ) : null}
            </>
          ) : (
            <>
              <DialogTitle>设置</DialogTitle>
              <DialogDescription>选择要查看或调整的项目。</DialogDescription>
            </>
          )}
        </DialogHeader>

        {view === "version" ? (
          <div
            className="dev-render-scroll min-h-0 space-y-3 overflow-y-auto overscroll-contain pr-1"
            data-slot="settings-dialog-body"
          >
            <VersionRow
              icon={<Monitor className="size-4" aria-hidden="true" />}
              label="Web"
              value={packageInfo.version}
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
        ) : view === "voice" ? (
          <VoiceSettingsPanel />
        ) : (
          <div
            className="dev-render-scroll min-h-0 space-y-2 overflow-y-auto overscroll-contain pr-1"
            data-slot="settings-dialog-body"
          >
            <SettingsMenuItem
              icon={<AudioLines className="size-4" aria-hidden="true" />}
              label="Voice Pilot"
              detail="用语音输入、听取回复和处理审批"
              onClick={() => setView("voice")}
            />
            <SettingsToggleItem
              icon={<Monitor className="size-4" aria-hidden="true" />}
              label="桌面交互模式"
              detail="适合平板外接键盘；保留触控，但按桌面输入处理"
              checked={desktopInteractionMode}
              onCheckedChange={setDesktopInteractionMode}
            />
            <SettingsToggleItem
              icon={<Activity className="size-4" aria-hidden="true" />}
              label="延迟监控"
              detail="显示可拖动的连接延迟浮窗"
              checked={latencyMonitorEnabled}
              onCheckedChange={setLatencyMonitorEnabled}
            />
            <SettingsMenuItem
              icon={<Server className="size-4" aria-hidden="true" />}
              label="版本"
              onClick={() => setView("version")}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsToggleItem({
  icon,
  label,
  detail,
  checked,
  onCheckedChange,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const detailId = useId();

  return (
    <button
      type="button"
      role="switch"
      className="flex w-full items-center gap-3 rounded-md border border-border bg-card/70 p-3 text-left transition-colors hover:border-primary/45 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      onClick={() => onCheckedChange(!checked)}
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={detailId}
      data-slot="settings-toggle-item"
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          checked
            ? "border-primary/45 bg-primary/15 text-primary"
            : "border-border text-muted-foreground",
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div id={labelId} className="text-sm font-medium text-foreground">
          {label}
        </div>
        <div id={detailId} className="mt-1 text-xs text-muted-foreground">
          {detail}
        </div>
      </div>
      <span
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
          checked ? "border-primary/70 bg-primary/80" : "border-border bg-muted/50",
        )}
        aria-hidden="true"
        data-slot="settings-toggle-switch"
      >
        <span
          className={cn(
            "absolute top-1/2 size-4 -translate-y-1/2 rounded-full bg-background shadow-sm transition-transform",
            checked ? "translate-x-[1.35rem]" : "translate-x-1",
          )}
        />
      </span>
    </button>
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
  detail?: string;
  onClick: () => void;
}) {
  const labelId = useId();
  const detailId = useId();

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-md border border-border bg-card/70 p-3 text-left transition-colors hover:border-primary/45 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      onClick={onClick}
      aria-labelledby={labelId}
      aria-describedby={detail ? detailId : undefined}
      data-slot="settings-menu-item"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/35 bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div id={labelId} className="text-sm font-medium text-foreground">
          {label}
        </div>
        {detail ? (
          <div id={detailId} className="mt-1 text-xs text-muted-foreground">
            {detail}
          </div>
        ) : null}
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
