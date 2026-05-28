import { useCallback, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  AudioLines,
  ChevronRight,
  KeyRound,
  Monitor,
  Server,
  SunMoon,
  Terminal,
} from "lucide-react";
import packageInfo from "../../../package.json" with { type: "json" };
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { VoiceSettingsPanel } from "@/components/shell/voice-settings-panel";
import {
  clearRelayClientToken,
  hasStoredRelayClientToken,
  persistRelayClientToken,
} from "@/lib/relay-client-token";
import type { ThemePreference } from "@/lib/theme-preference";
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

type SettingsView = "menu" | "version" | "voice" | "relay-token";

const themePreferenceOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "auto", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

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

function settingsViewTitle(view: SettingsView): string {
  if (view === "version") return "版本";
  if (view === "relay-token") return "Relay Token";
  return "设置 Voice Pilot";
}

function settingsViewDescription(view: SettingsView): string {
  if (view === "version") return "当前 Web 与 Relay 服务器的版本信息";
  if (view === "relay-token") return "用于连接需要认证的 Relay 服务器。保存后自动生效。";
  return "连接语音服务后，即可以语音交互的形式驱动会话。";
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const relayUrl = useAppStore((s) => s.relayUrl);
  const latencyMonitorEnabled = useAppStore((s) => s.latencyMonitorEnabled);
  const setLatencyMonitorEnabled = useAppStore((s) => s.setLatencyMonitorEnabled);
  const desktopInteractionMode = useAppStore((s) => s.desktopInteractionMode);
  const setDesktopInteractionMode = useAppStore((s) => s.setDesktopInteractionMode);
  const themePreference = useAppStore((s) => s.themePreference);
  const setThemePreference = useAppStore((s) => s.setThemePreference);
  const ptyScrollTraceEnabled = useAppStore((s) => s.ptyScrollTraceEnabled);
  const setPtyScrollTraceEnabled = useAppStore((s) => s.setPtyScrollTraceEnabled);
  const [view, setView] = useState<SettingsView>("menu");
  const [relayHealth, setRelayHealth] = useState<RelayHealthState>({ kind: "idle" });
  const relayTokenSaved = hasStoredRelayClientToken();

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
          message: err instanceof Error ? "当前 Relay 服务器无法读取版本" : "读取失败",
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
        : "从当前 Relay 服务器 /health 读取";

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
                  <DialogTitle>{settingsViewTitle(view)}</DialogTitle>
                  <DialogDescription className={cn(view === "voice" && "max-w-[28rem] leading-5")}>
                    {settingsViewDescription(view)}
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
              <DialogDescription>连接、交互和诊断选项。</DialogDescription>
            </>
          )}
        </DialogHeader>

        {view === "version" ? (
          <div
            className="dev-render-scroll min-h-0 space-y-3 overflow-y-auto overscroll-contain pr-4 sm:pr-1"
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
              label="Relay 服务器"
              value={relayVersion}
              detail={relayDetail}
              muted={relayHealth.kind === "error"}
            />
          </div>
        ) : view === "relay-token" ? (
          <RelayTokenPanel saved={relayTokenSaved} />
        ) : view === "voice" ? (
          <VoiceSettingsPanel />
        ) : (
          <div
            className="dev-render-scroll min-h-0 space-y-4 overflow-y-auto overscroll-contain pr-4 sm:pr-1"
            data-slot="settings-dialog-body"
          >
            <SettingsSection title="服务">
              <SettingsMenuItem
                icon={<AudioLines className="size-4" aria-hidden="true" />}
                label="Voice Pilot"
                detail="用语音输入、听取回复和处理审批"
                onClick={() => setView("voice")}
              />
              <SettingsMenuItem
                icon={<KeyRound className="size-4" aria-hidden="true" />}
                label="Relay Token"
                detail={`${relayTokenSaved ? "已保存" : "未设置"}；用于连接需要认证的 Relay 服务器`}
                onClick={() => setView("relay-token")}
              />
            </SettingsSection>
            <SettingsSection title="外观">
              <SettingsSegmentedItem
                icon={<SunMoon className="size-4" aria-hidden="true" />}
                label="主题"
                value={themePreference}
                options={themePreferenceOptions}
                onValueChange={setThemePreference}
              />
            </SettingsSection>
            <SettingsSection title="交互">
              <SettingsToggleItem
                icon={<Monitor className="size-4" aria-hidden="true" />}
                label="桌面交互模式"
                detail="适合平板外接键盘；保留触控，但按桌面输入处理"
                checked={desktopInteractionMode}
                onCheckedChange={setDesktopInteractionMode}
              />
            </SettingsSection>
            <SettingsSection title="诊断">
              <SettingsToggleItem
                icon={<Terminal className="size-4" aria-hidden="true" />}
                label="PTY 滚动追踪"
                detail="记录终端滚动和视口同步现场，方便复制诊断报告"
                checked={ptyScrollTraceEnabled}
                onCheckedChange={setPtyScrollTraceEnabled}
              />
              <SettingsToggleItem
                icon={<Activity className="size-4" aria-hidden="true" />}
                label="延迟监控"
                detail="显示可拖动的连接延迟浮窗"
                checked={latencyMonitorEnabled}
                onCheckedChange={setLatencyMonitorEnabled}
              />
            </SettingsSection>
            <SettingsSection title="关于">
              <SettingsMenuItem
                icon={<Server className="size-4" aria-hidden="true" />}
                label="版本"
                onClick={() => setView("version")}
              />
            </SettingsSection>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2" data-slot="settings-section">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="overflow-hidden rounded-lg border border-border bg-card/55 divide-y divide-border/70">
        {children}
      </div>
    </section>
  );
}

function SettingsSegmentedItem({
  icon,
  label,
  detail,
  value,
  options,
  onValueChange,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  value: ThemePreference;
  options: Array<{ value: ThemePreference; label: string }>;
  onValueChange: (value: ThemePreference) => void;
}) {
  const labelId = useId();
  const detailId = useId();

  return (
    <div
      className="flex w-full items-start gap-3 px-3 py-3 text-left"
      data-slot="settings-choice-item"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background/55 text-muted-foreground">
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
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-describedby={detail ? detailId : undefined}
          className="mt-3 grid grid-cols-3 gap-1 rounded-md border border-border bg-muted/70 p-1"
          data-slot="settings-theme-choice"
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={cn(
                  "min-w-0 whitespace-nowrap rounded px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/55 hover:text-foreground",
                )}
                onClick={() => onValueChange(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RelayTokenPanel({ saved }: { saved: boolean }) {
  const inputId = useId();
  const errorId = useId();
  const [tokenInput, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reloadForReconnect = () => {
    window.location.reload();
  };

  const saveToken = () => {
    const token = tokenInput.trim();
    if (!token) {
      setError("请输入 Relay Token。");
      return;
    }
    persistRelayClientToken(token);
    reloadForReconnect();
  };

  const clearToken = () => {
    clearRelayClientToken();
    reloadForReconnect();
  };

  return (
    <form
      className="dev-render-scroll min-h-0 space-y-3 overflow-y-auto overscroll-contain pr-4 sm:pr-1"
      data-slot="settings-dialog-body"
      onSubmit={(event) => {
        event.preventDefault();
        saveToken();
      }}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={inputId} className="text-sm font-medium text-foreground">
            Relay client token
          </label>
          <span className="shrink-0 text-xs text-muted-foreground">
            {saved ? "已保存 token" : "未保存"}
          </span>
        </div>
        <input
          id={inputId}
          type="password"
          value={tokenInput}
          onChange={(event) => {
            setTokenInput(event.currentTarget.value);
            if (error) setError(null);
          }}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={error ? errorId : undefined}
          className="h-10 w-full rounded-md border border-border bg-muted px-3 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/55 focus:ring-2 focus:ring-ring/45"
          placeholder="粘贴 Relay Token"
        />
        {error ? (
          <p id={errorId} className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {saved ? (
          <Button type="button" variant="outline" onClick={clearToken}>
            清空
          </Button>
        ) : null}
        <Button type="submit" disabled={!tokenInput.trim()}>
          保存
        </Button>
      </div>
    </form>
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
      className="group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={() => onCheckedChange(!checked)}
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={detailId}
      data-slot="settings-toggle-item"
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md bg-background/55 transition-colors",
          checked ? "text-primary" : "text-muted-foreground",
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
          checked ? "border-primary/65 bg-primary/70" : "border-border bg-muted/50",
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
      className="group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onClick}
      aria-labelledby={labelId}
      aria-describedby={detail ? detailId : undefined}
      data-slot="settings-menu-item"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background/55 text-muted-foreground transition-colors group-hover:text-foreground">
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
