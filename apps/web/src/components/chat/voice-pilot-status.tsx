import { Square } from "lucide-react";
import type { CSSProperties } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VOICE_PILOT_STATE,
  useVoicePilotStore,
  type VoicePilotPhase,
} from "@/voice/voice-pilot-store";

const PHASE_LABELS: Record<VoicePilotPhase, string> = {
  idle: "未开启",
  starting: "正在启动",
  listening: "正在聆听",
  drafting: "等待补充",
  submitting: "正在发送",
  waiting: "等待回复",
  summarizing: "正在摘要",
  speaking: "正在播报",
  approval: "等待语音审批",
  paused: "已暂停",
  error: "需要处理",
};

const PHASE_CHIPS: Record<VoicePilotPhase, string> = {
  idle: "离线",
  starting: "启动",
  listening: "聆听",
  drafting: "收音",
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
  drafting: "live",
  submitting: "active",
  waiting: "active",
  summarizing: "active",
  speaking: "speak",
  approval: "approval",
  paused: "quiet",
  error: "error",
};

const WAVE_WEIGHTS = [
  0.04, -0.34, 0.48, -0.18, 0.76, -0.52, 0.92, -0.36, 0.58, -0.62, 0.24, -0.2, 0.08,
];
const WAVE_VIEWBOX = { width: 120, height: 28 };

function activityForPhase(phase: VoicePilotPhase, level: number): number {
  if (phase === "paused" || phase === "idle" || phase === "error") return 0.08;
  if (phase === "waiting") return 0.18;
  if (phase === "approval") return Math.max(0.34, level);
  if (phase === "summarizing" || phase === "submitting" || phase === "starting") {
    return Math.max(0.42, level);
  }
  if (phase === "speaking" || phase === "listening" || phase === "drafting") {
    return Math.max(0.18, level);
  }
  return level;
}

function buildWavePath(activity: number): string {
  const width = WAVE_VIEWBOX.width;
  const height = WAVE_VIEWBOX.height;
  const centerY = height / 2;
  const amplitude = 4 + activity * 14;
  const points = WAVE_WEIGHTS.map((weight, index) => {
    const x = (index / (WAVE_WEIGHTS.length - 1)) * width;
    const y = centerY - weight * amplitude;
    return { x, y };
  });

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

  if (!pilot.enabled) return null;

  const activity = activityForPhase(pilot.phase, pilot.activityLevel);
  const tone = PHASE_TONE[pilot.phase];
  const active = pilot.phase !== "paused" && pilot.phase !== "error";
  const wavePath = buildWavePath(activity);
  const waveOpacity = 0.34 + activity * 0.5;
  const waveOpacityLow = 0.3 + activity * 0.42;
  const waveOpacityHigh = 0.46 + activity * 0.5;

  return (
    <div
      data-slot="voice-pilot-status"
      data-phase={pilot.phase}
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
            {PHASE_CHIPS[pilot.phase]}
          </span>
        </div>
        <div className="mt-1 min-w-0 truncate text-xs text-muted-foreground">
          {pilot.error ?? PHASE_LABELS[pilot.phase]}
        </div>
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
        data-activity-level={Math.round(activity * 100)}
        className="dev-voice-waveform col-span-2"
        style={
          {
            "--voice-level": activity,
            "--voice-opacity": waveOpacity.toFixed(3),
            "--voice-opacity-low": waveOpacityLow.toFixed(3),
            "--voice-opacity-high": waveOpacityHigh.toFixed(3),
          } as CSSProperties
        }
      >
        <svg
          aria-hidden="true"
          className="dev-voice-waveform-svg"
          viewBox={`0 0 ${WAVE_VIEWBOX.width} ${WAVE_VIEWBOX.height}`}
          preserveAspectRatio="none"
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
