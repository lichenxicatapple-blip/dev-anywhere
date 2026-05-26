import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown, RefreshCw } from "lucide-react";
import { relayClientRef } from "@/hooks/use-relay-setup";
import type { LatencyProbeResult } from "@/services/relay-client";
import { useAppStore } from "@/stores/app-store";
import { readStorageValue, STORAGE_KEYS, writeStorageValue } from "@/lib/storage-keys";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type LinkKey = "webRelay" | "relayProxy" | "webProxy";
type LinkState = "idle" | "measuring" | "ok" | "warn" | "bad" | "unavailable";

interface LinkMeasurement {
  state: LinkState;
  rttMs?: number;
  error?: string;
  updatedAt?: number;
}

type Measurements = Record<LinkKey, LinkMeasurement>;

const ACTIVE_SAMPLE_INTERVAL_MS = 3_000;
const HIDDEN_SAMPLE_INTERVAL_MS = 10_000;
const FLOATING_MARGIN_PX = 12;
const DRAG_THRESHOLD_PX = 4;

const LINK_LABELS: Record<LinkKey, string> = {
  webRelay: "浏览器 ↔ 中转服务",
  relayProxy: "中转服务 ↔ 开发机",
  webProxy: "浏览器 ↔ 开发机",
};

const initialMeasurements: Measurements = {
  webRelay: { state: "idle" },
  relayProxy: { state: "idle" },
  webProxy: { state: "idle" },
};

interface FloatingPosition {
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  dragging: boolean;
}

function classify(result: LatencyProbeResult): LinkMeasurement {
  if (!result.success || result.rttMs === undefined) {
    return {
      state: "unavailable",
      error: result.error ?? "不可用",
      updatedAt: Date.now(),
    };
  }
  const rttMs = result.rttMs;
  return {
    state: rttMs <= 120 ? "ok" : rttMs <= 300 ? "warn" : "bad",
    rttMs,
    updatedAt: Date.now(),
  };
}

function unavailable(error: string): LinkMeasurement {
  return { state: "unavailable", error, updatedAt: Date.now() };
}

function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  return `${Math.max(0, Math.round(value))}ms`;
}

function stateRank(state: LinkState): number {
  switch (state) {
    case "bad":
      return 4;
    case "unavailable":
      return 3;
    case "warn":
      return 2;
    case "measuring":
      return 1;
    default:
      return 0;
  }
}

function stateTone(state: LinkState): "ok" | "warn" | "bad" | "neutral" {
  if (state === "bad" || state === "unavailable") return "bad";
  if (state === "warn") return "warn";
  if (state === "ok") return "ok";
  return "neutral";
}

function toneClasses(tone: ReturnType<typeof stateTone>): string {
  switch (tone) {
    case "ok":
      return "border-emerald-500/35 bg-emerald-500/10 text-emerald-300";
    case "warn":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "bad":
      return "border-destructive/55 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-card/90 text-muted-foreground";
  }
}

function statusLabel(measurement: LinkMeasurement): string {
  if (measurement.state === "measuring") return "检测中";
  if (measurement.state === "unavailable") return measurement.error ?? "不可用";
  if (measurement.rttMs !== undefined) return formatMs(measurement.rttMs);
  return "等待检测";
}

function readStoredPosition(): FloatingPosition | null {
  const raw = readStorageValue("local", STORAGE_KEYS.latencyMonitorPosition);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FloatingPosition>;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: Number(parsed.x), y: Number(parsed.y) };
  } catch {
    return null;
  }
}

function persistPosition(position: FloatingPosition): void {
  writeStorageValue("local", STORAGE_KEYS.latencyMonitorPosition, JSON.stringify(position));
}

function viewportSize(): { width: number; height: number } {
  return {
    width:
      window.visualViewport?.width ??
      window.innerWidth ??
      document.documentElement.clientWidth ??
      0,
    height:
      window.visualViewport?.height ??
      window.innerHeight ??
      document.documentElement.clientHeight ??
      0,
  };
}

function clampPosition(
  position: FloatingPosition,
  size: { width: number; height: number },
): FloatingPosition {
  const viewport = viewportSize();
  const minX = FLOATING_MARGIN_PX;
  const minY = FLOATING_MARGIN_PX;
  const maxX = Math.max(minX, viewport.width - size.width - FLOATING_MARGIN_PX);
  const maxY = Math.max(minY, viewport.height - size.height - FLOATING_MARGIN_PX);
  return {
    x: Math.min(maxX, Math.max(minX, Math.round(position.x))),
    y: Math.min(maxY, Math.max(minY, Math.round(position.y))),
  };
}

export function LatencyMonitor() {
  const enabled = useAppStore((s) => s.latencyMonitorEnabled);
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const [measurements, setMeasurements] = useState<Measurements>(initialMeasurements);
  const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(() =>
    readStoredPosition(),
  );
  const measuringRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const worstState = useMemo(
    () =>
      (
        Object.values(measurements).sort((a, b) => stateRank(b.state) - stateRank(a.state))[0] ?? {
          state: "idle",
        }
      ).state,
    [measurements],
  );
  const tone = stateTone(worstState);

  async function sample(): Promise<void> {
    if (measuringRef.current) return;
    const relay = relayClientRef;
    if (!relay || !connected) {
      const offline = unavailable("Relay 未连接");
      setMeasurements({ webRelay: offline, relayProxy: offline, webProxy: offline });
      return;
    }

    measuringRef.current = true;
    setMeasurements((prev) => ({
      webRelay: { ...prev.webRelay, state: "measuring" },
      relayProxy: proxyOnline
        ? { ...prev.relayProxy, state: "measuring" }
        : unavailable("未连接开发机"),
      webProxy: proxyOnline
        ? { ...prev.webProxy, state: "measuring" }
        : unavailable("未连接开发机"),
    }));

    const [webRelay, relayProxy, webProxy] = await Promise.allSettled([
      relay.measureWebRelayLatency(),
      proxyOnline ? relay.measureRelayProxyLatency() : Promise.resolve({ success: false }),
      proxyOnline ? relay.measureWebProxyLatency() : Promise.resolve({ success: false }),
    ]);

    setMeasurements({
      webRelay:
        webRelay.status === "fulfilled"
          ? classify(webRelay.value)
          : unavailable(webRelay.reason instanceof Error ? webRelay.reason.message : "测速失败"),
      relayProxy:
        relayProxy.status === "fulfilled"
          ? classify(relayProxy.value)
          : unavailable(
              relayProxy.reason instanceof Error ? relayProxy.reason.message : "测速失败",
            ),
      webProxy:
        webProxy.status === "fulfilled"
          ? classify(webProxy.value)
          : unavailable(webProxy.reason instanceof Error ? webProxy.reason.message : "测速失败"),
    });
    measuringRef.current = false;
  }

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      await sample();
      if (disposed) return;
      timer = setTimeout(
        tick,
        document.hidden ? HIDDEN_SAMPLE_INTERVAL_MS : ACTIVE_SAMPLE_INTERVAL_MS,
      );
    };

    void tick();
    return () => {
      disposed = true;
      measuringRef.current = false;
      if (timer) clearTimeout(timer);
    };
    // selectedProxyId is intentionally included to resample immediately after proxy switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, connected, proxyOnline, selectedProxyId]);

  useEffect(() => {
    if (!enabled || !floatingPosition) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const next = clampPosition(floatingPosition, { width: rect.width, height: rect.height });
    if (next.x === floatingPosition.x && next.y === floatingPosition.y) return;
    setFloatingPosition(next);
    persistPosition(next);
  }, [enabled, floatingPosition]);

  if (!enabled) return null;

  const compactProxy =
    measurements.webProxy.rttMs !== undefined ? measurements.webProxy : measurements.relayProxy;

  const floatingStyle =
    floatingPosition !== null
      ? {
          left: `${floatingPosition.x}px`,
          top: `${floatingPosition.y}px`,
        }
      : undefined;

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      width: rect.width,
      height: rect.height,
      dragging: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.dragging && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;
    drag.dragging = true;
    event.preventDefault();
    const next = clampPosition(
      {
        x: drag.originX + deltaX,
        y: drag.originY + deltaY,
      },
      { width: drag.width, height: drag.height },
    );
    setFloatingPosition(next);
  }

  function finishPointerDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!drag.dragging) return;
    event.preventDefault();
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 200);
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const next = clampPosition(
      {
        x: drag.originX + deltaX,
        y: drag.originY + deltaY,
      },
      { width: drag.width, height: drag.height },
    );
    setFloatingPosition(next);
    persistPosition(next);
  }

  function cancelPointerDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function handleClickCapture(event: React.MouseEvent<HTMLButtonElement>): void {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            "fixed z-40 flex max-w-[calc(100vw-1.5rem)] touch-none cursor-move select-none items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs shadow-lg backdrop-blur transition-colors",
            floatingPosition === null &&
              "right-[calc(env(safe-area-inset-right)+0.75rem)] top-[calc(env(safe-area-inset-top)+3.75rem)] md:right-4 md:top-4",
            toneClasses(tone),
          )}
          style={floatingStyle}
          data-slot="latency-monitor-trigger"
          aria-label={`延迟监控，中转服务 ${formatMs(measurements.webRelay.rttMs)}，开发机 ${formatMs(compactProxy.rttMs)}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerDrag}
          onPointerCancel={cancelPointerDrag}
          onClickCapture={handleClickCapture}
        >
          <Activity className="size-3.5" aria-hidden="true" />
          <span className="font-medium text-foreground">延迟</span>
          <span className="hidden text-muted-foreground sm:inline">
            中转 {formatMs(measurements.webRelay.rttMs)}
          </span>
          <span className="text-muted-foreground">开发机 {formatMs(compactProxy.rttMs)}</span>
          <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-3" data-slot="latency-monitor-popover">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-foreground">连接延迟</div>
            <div className="mt-1 text-xs text-muted-foreground">数值越低，操作响应通常越快。</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="立即测速"
            onClick={() => void sample()}
          >
            <RefreshCw className="size-3" aria-hidden="true" />
          </Button>
        </div>

        <div className="mt-3 space-y-2">
          {(Object.keys(LINK_LABELS) as LinkKey[]).map((key) => (
            <LatencyRow key={key} label={LINK_LABELS[key]} measurement={measurements[key]} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LatencyRow({ label, measurement }: { label: string; measurement: LinkMeasurement }) {
  const tone = stateTone(measurement.state);
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/70 bg-card/60 px-3 py-2">
      <div className="min-w-0 truncate text-xs font-medium text-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            tone === "ok"
              ? "bg-emerald-400"
              : tone === "warn"
                ? "bg-amber-400"
                : tone === "bad"
                  ? "bg-destructive"
                  : "bg-muted-foreground/60",
          )}
          aria-hidden="true"
        />
        <span className="min-w-[4rem] text-right font-mono text-xs text-foreground">
          {statusLabel(measurement)}
        </span>
      </div>
    </div>
  );
}
