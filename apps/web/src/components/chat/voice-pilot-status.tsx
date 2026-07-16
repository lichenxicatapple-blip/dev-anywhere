import { X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VOICE_PILOT_STATE,
  useVoicePilotStore,
  type VoicePilotPhase,
} from "@/voice/voice-pilot-store";
import {
  pcmWaveformDisplayValue,
  VOICE_WAVEFORM_BIN_CAPACITY,
  type PcmWaveformBin,
} from "@/voice/pcm-waveform";

const PHASE_CHIPS: Record<VoicePilotPhase, string> = {
  idle: "离线",
  starting: "准备中",
  listening: "聆听",
  submitting: "发送",
  waiting: "等待",
  summarizing: "摘要",
  speaking: "播报",
  approval: "审批",
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
  error: "error",
};

const WAVE_VIEWBOX = { width: 120, height: 28 };

function buildWavePath(waveform: PcmWaveformBin[]): string {
  const width = WAVE_VIEWBOX.width;
  const height = WAVE_VIEWBOX.height;
  if (waveform.length === 0) return "";
  const offset = VOICE_WAVEFORM_BIN_CAPACITY - waveform.length;

  return waveform
    .map((bin, index) => {
      const x = ((offset + index + 0.5) / VOICE_WAVEFORM_BIN_CAPACITY) * width;
      const max = pcmWaveformDisplayValue(bin.max);
      const min = pcmWaveformDisplayValue(bin.min);
      const top = ((1 - max) * height) / 2;
      const bottom = ((1 - min) * height) / 2;
      return `M ${x.toFixed(2)} ${top.toFixed(2)} L ${x.toFixed(2)} ${bottom.toFixed(2)}`;
    })
    .join(" ");
}

export function VoicePilotStatus({ sessionId }: { sessionId: string }) {
  const pilot = useVoicePilotStore((s) => s.bySessionId[sessionId] ?? DEFAULT_VOICE_PILOT_STATE);
  const disable = useVoicePilotStore((s) => s.disable);
  const enabled = pilot.enabled;
  const phase = pilot.phase;
  const level = pilot.activityLevel;

  if (!enabled) return null;

  const tone = PHASE_TONE[phase];
  const active = phase !== "error";
  const wavePath = buildWavePath(pilot.waveform);
  const detailText = pilot.error?.trim() || null;

  return (
    <div
      data-slot="voice-pilot-status"
      data-phase={phase}
      data-tone={tone}
      role="status"
      aria-live="polite"
      className={cn(
        "dev-voice-pilot-panel mb-2 min-h-[4.5rem] overflow-hidden rounded-md border px-3 py-2.5 text-sm shadow-sm",
        active && "dev-voice-pilot-panel-active",
      )}
    >
      <div className="min-w-0 pr-8">
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="停止 Voice Pilot"
            data-slot="voice-pilot-stop"
            className="dev-voice-pilot-stop absolute right-2 top-2 size-7 rounded-[5px] p-0"
            onClick={() => disable(sessionId)}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">停止 Voice Pilot</TooltipContent>
      </Tooltip>
      <div
        data-slot="voice-pilot-waveform"
        data-activity-level={Math.round(level * 100)}
        data-waveform-bins={pilot.waveform.length}
        className="dev-voice-waveform mt-2"
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
