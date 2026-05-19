import { Square } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VOICE_PILOT_STATE,
  useVoicePilotStore,
  type VoicePilotPhase,
} from "@/voice/voice-pilot-store";

const PHASE_CHIPS: Record<VoicePilotPhase, string> = {
  idle: "离线",
  starting: "启动",
  listening: "聆听",
  submitting: "发送",
  waiting: "等待",
  summarizing: "摘要",
  speaking: "播报",
  approval: "审批",
  paused: "暂停",
  error: "异常",
};

const PHASE_TONE: Record<VoicePilotPhase, string> = {
  idle: "quiet",
  starting: "active",
  listening: "live",
  submitting: "active",
  waiting: "active",
  summarizing: "active",
  speaking: "speak",
  approval: "approval",
  paused: "quiet",
  error: "error",
};

const WAVE_VIEWBOX = { width: 120, height: 28 };
const WAVE_HISTORY_LEN = 32;
const WAVE_FRAME_MS = 60;

function activityForPhase(phase: VoicePilotPhase, level: number): number {
  if (phase === "paused" || phase === "idle" || phase === "error") return 0.08;
  if (phase === "waiting") return 0.18;
  if (phase === "approval") return Math.max(0.34, level);
  if (phase === "summarizing" || phase === "submitting" || phase === "starting") {
    return Math.max(0.42, level);
  }
  if (phase === "speaking" || phase === "listening") {
    return Math.max(0.18, level);
  }
  return level;
}

function buildWavePath(history: number[]): string {
  const width = WAVE_VIEWBOX.width;
  const height = WAVE_VIEWBOX.height;
  const centerY = height / 2;
  const len = history.length;
  if (len === 0) {
    return `M 0 ${centerY.toFixed(1)} H ${width.toFixed(1)}`;
  }
  // 基于实时音量历史绘制对称波形: 上下镜像, 振幅与每帧音量正相关
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < len; i += 1) {
    const value = Math.max(0, Math.min(1, history[i] ?? 0));
    const x = (i / Math.max(1, len - 1)) * width;
    const sign = i % 2 === 0 ? 1 : -1;
    // 0.5 是基础静态高度防止纯静音时是平线
    const y = centerY - sign * (value * (height / 2 - 1) + 0.5);
    points.push({ x, y });
  }
  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    path += ` Q ${current.x.toFixed(1)} ${current.y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  path += ` T ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return path;
}

export function VoicePilotStatus({ sessionId }: { sessionId: string }) {
  const pilot = useVoicePilotStore((s) => s.bySessionId[sessionId] ?? DEFAULT_VOICE_PILOT_STATE);
  const disable = useVoicePilotStore((s) => s.disable);
  const enabled = pilot.enabled;
  const phase = pilot.phase;
  const level = pilot.activityLevel;

  // 当前帧音量(派生): 受 phase 调制后的目标振幅; 用于实时显示和填入历史
  const currentActivity = activityForPhase(phase, level);
  // 用 ref + tick 节流维护最近 N 帧, 避免每个 PCM chunk 都重渲染
  const phaseRef = useRef(phase);
  const levelRef = useRef(level);
  phaseRef.current = phase;
  levelRef.current = level;
  const [history, setHistory] = useState<number[]>(() =>
    new Array(WAVE_HISTORY_LEN).fill(currentActivity),
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      const value = activityForPhase(phaseRef.current, levelRef.current);
      setHistory((prev) => {
        const next = prev.length >= WAVE_HISTORY_LEN ? prev.slice(1) : prev.slice();
        next.push(value);
        return next;
      });
    }, WAVE_FRAME_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;

  const tone = PHASE_TONE[phase];
  const active = phase !== "paused" && phase !== "error";
  const wavePath = buildWavePath(history);
  const waveOpacity = 0.34 + currentActivity * 0.5;
  const waveOpacityLow = 0.3 + currentActivity * 0.42;
  const waveOpacityHigh = 0.46 + currentActivity * 0.5;
  const detailText = pilot.error?.trim() || null;

  return (
    <div
      data-slot="voice-pilot-status"
      data-phase={phase}
      data-tone={tone}
      role="status"
      aria-live="polite"
      className={cn(
        "dev-voice-pilot-panel mb-2 grid min-h-[4.5rem] grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 overflow-hidden rounded-md border px-3 py-2.5 text-sm shadow-sm",
        active && "dev-voice-pilot-panel-active",
      )}
    >
      <div className="min-w-0 self-start">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold text-foreground">Voice Pilot</span>
          <span
            data-slot="voice-pilot-live-chip"
            className="dev-voice-pilot-chip rounded-[3px] border px-1.5 py-0.5 text-[10px] font-medium leading-none tracking-normal"
          >
            {PHASE_CHIPS[phase]}
          </span>
        </div>
        {detailText ? (
          <div className="mt-1 min-w-0 truncate text-xs text-muted-foreground">{detailText}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-start">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="停止 Voice Pilot"
              data-slot="voice-pilot-stop"
              className="dev-voice-pilot-stop size-8 rounded-[5px] border p-0"
              onClick={() => disable(sessionId)}
            >
              <Square aria-hidden="true" className="size-3 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">停止 Voice Pilot</TooltipContent>
        </Tooltip>
      </div>
      <div
        data-slot="voice-pilot-waveform"
        data-activity-level={Math.round(currentActivity * 100)}
        className="dev-voice-waveform col-span-2"
        style={
          {
            "--voice-level": currentActivity,
            "--voice-opacity": waveOpacity.toFixed(3),
            "--voice-opacity-low": waveOpacityLow.toFixed(3),
            "--voice-opacity-high": waveOpacityHigh.toFixed(3),
          } as CSSProperties
        }
      >
        <svg
          aria-hidden="true"
          data-slot="voice-pilot-waveform-svg"
          className="dev-voice-waveform-svg"
          viewBox={`0 0 ${WAVE_VIEWBOX.width} ${WAVE_VIEWBOX.height}`}
          preserveAspectRatio="none"
          style={{ width: "calc(100% - 1rem)", height: "calc(100% - 0.7rem)" }}
        >
          <path
            className="dev-voice-waveform-baseline"
            d={`M 0 ${WAVE_VIEWBOX.height / 2} H ${WAVE_VIEWBOX.width}`}
          />
          <path
            data-slot="voice-pilot-waveform-curve"
            className="dev-voice-waveform-curve"
            d={wavePath}
          />
        </svg>
      </div>
    </div>
  );
}
