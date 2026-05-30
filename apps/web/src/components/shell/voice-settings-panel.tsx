import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type {
  VoiceCapabilities,
  VoiceConfigUpdate,
  VoiceOption,
  VoiceProviderConfig,
} from "@dev-anywhere/shared";
import { createBundledBailianVoiceCapabilities } from "@dev-anywhere/shared";
import { Check, ChevronDown, KeyRound, Play, Save as SaveIcon, Trash2 } from "lucide-react";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { Button } from "@/components/ui/button";
import { PcmStreamPlayer } from "@/voice/pcm-stream-player";

type SaveState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "saving" }
  | { kind: "testing" }
  | { kind: "playingTest"; transcript?: string }
  | { kind: "testPassed"; transcript?: string }
  | { kind: "saved" }
  | { kind: "error"; message: string };

const DEFAULT_CONFIG: VoiceProviderConfig = {
  provider: "aliyun-bailian",
  configured: false,
  region: "cn",
  asrModel: "qwen3-asr-flash-realtime",
  ttsModel: "cosyvoice-v3-flash",
  ttsVoice: "longanyang",
  turnIdleSeconds: 3,
};

const inputClassName =
  "min-h-11 min-w-0 rounded-md border border-border bg-input px-3 text-base outline-none transition-colors placeholder:text-muted-foreground/65 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-h-0 md:text-sm";
const MIN_TEST_PLAYBACK_MS = 800;
const MIN_SAVE_PENDING_MS = 300;
const SAVE_SUCCESS_HOLD_MS = 1600;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

interface ChoiceOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function voicesForModel(voices: VoiceOption[], model: string): VoiceOption[] {
  return voices.filter((voice) => !voice.model || voice.model === model);
}

function FieldBlock({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactNode;
  help?: string | null;
}) {
  return (
    <div className="block min-w-0 rounded-lg border border-border/75 bg-card/55 p-3.5 transition-colors focus-within:border-primary/45 focus-within:bg-card/75 sm:p-3">
      <span className="block text-[13px] font-medium leading-none text-muted-foreground">
        {label}
      </span>
      <div className="mt-2 min-w-0">{children}</div>
      {help ? (
        <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">{help}</span>
      ) : null}
    </div>
  );
}

function ChoiceField({
  label,
  value,
  options,
  onChange,
  placeholder = "请选择",
  help,
}: {
  label: string;
  value: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  help?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? (value ? value : placeholder);
  const enabledOptions = options.filter((option) => !option.disabled);
  const selectedHasDetail = Boolean(splitOptionLabel(selectedLabel).detail);

  return (
    <div
      className="min-w-0 rounded-lg border border-border/75 bg-card/55 p-3.5 sm:p-3"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <div id={labelId} className="text-[13px] font-medium leading-none text-muted-foreground">
        {label}
      </div>
      <button
        type="button"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={enabledOptions.length === 0}
        className={`mt-2 flex w-full min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-input px-3 text-left outline-none transition-colors hover:border-primary/40 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${selectedHasDetail ? "min-h-[60px] py-2" : "min-h-11"}`}
        onClick={() => setOpen((current) => !current)}
        data-slot="voice-settings-choice-trigger"
      >
        <ChoiceLabel label={selectedLabel} muted={!selected && !value} />
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-labelledby={labelId}
          className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border/80 bg-popover p-1 shadow-sm"
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-label={option.label}
                aria-selected={active}
                disabled={option.disabled}
                className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2.5 py-2.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-primary">
                  {active ? <Check className="size-4" aria-hidden="true" /> : null}
                </span>
                <ChoiceLabel label={option.label} />
              </button>
            );
          })}
        </div>
      ) : null}
      {help ? (
        <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{help}</div>
      ) : null}
    </div>
  );
}

function ChoiceLabel({ label, muted = false }: { label: string; muted?: boolean }) {
  const parts = splitOptionLabel(label);
  return (
    <span className="min-w-0 flex-1">
      <span
        className={`block truncate text-base leading-6 md:text-sm ${muted ? "text-muted-foreground" : "text-foreground"}`}
      >
        {parts.title}
      </span>
      {parts.detail ? (
        <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">
          {parts.detail}
        </span>
      ) : null}
    </span>
  );
}

export function VoiceSettingsPanel({ scrollRef }: { scrollRef?: Ref<HTMLDivElement> } = {}) {
  const [config, setConfig] = useState<VoiceProviderConfig>(DEFAULT_CONFIG);
  const [turnIdleSecondsInput, setTurnIdleSecondsInput] = useState(
    String(DEFAULT_CONFIG.turnIdleSeconds),
  );
  const [capabilities, setCapabilities] = useState<VoiceCapabilities>(() =>
    createBundledBailianVoiceCapabilities(),
  );
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const testAudioContextRef = useRef<AudioContext | null>(null);
  const testPlayerRef = useRef<PcmStreamPlayer | null>(null);
  const testPlaybackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const relay = relayClientRef;
    if (!relay) {
      setState({ kind: "error", message: "请先连接 Relay 服务器" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    void relay
      .requestVoiceConfig()
      .then((result) => {
        if (cancelled) return;
        if (result.error || !result.config) {
          setState({ kind: "error", message: result.error ?? "读取语音设置失败" });
          return;
        }
        setConfig(result.config);
        setTurnIdleSecondsInput(String(result.config.turnIdleSeconds));
        setApiKey("");
        setClearApiKey(false);
        setConfigLoaded(true);
        setState({ kind: "idle" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "读取语音设置失败",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const relay = relayClientRef;
    if (!relay || !configLoaded) return;
    let cancelled = false;
    void relay
      .requestVoiceCapabilities({ region: config.region })
      .then((result) => {
        if (cancelled) return;
        if (result.error || !result.capabilities) {
          setCapabilities(createBundledBailianVoiceCapabilities());
          return;
        }
        setCapabilities(result.capabilities);
      })
      .catch(() => {
        if (cancelled) return;
        setCapabilities(createBundledBailianVoiceCapabilities());
      });
    return () => {
      cancelled = true;
    };
  }, [config.region, configLoaded]);

  useEffect(() => {
    return () => {
      stopTestPlayback();
      clearSaveFeedbackTimer();
    };
  }, []);

  const statusText = useMemo<string | null>(() => {
    if (state.kind === "loading") return "读取中...";
    if (state.kind === "saving") return "保存中...";
    if (state.kind === "testing") return "正在测试语音合成";
    if (state.kind === "playingTest") return "正在播放测试音频";
    if (state.kind === "testPassed") return "测试通过";
    if (state.kind === "saved") return "已保存";
    if (state.kind === "error") return state.message;
    return null;
  }, [state]);

  const busy =
    state.kind === "saving" ||
    state.kind === "loading" ||
    state.kind === "testing" ||
    state.kind === "playingTest";
  const compatibleTtsVoices = useMemo(
    () => voicesForModel(capabilities.ttsVoices, config.ttsModel),
    [capabilities.ttsVoices, config.ttsModel],
  );
  const selectedTtsVoiceIsCompatible = compatibleTtsVoices.some(
    (voice) => voice.value === config.ttsVoice,
  );
  const selectedTtsVoice = selectedTtsVoiceIsCompatible ? config.ttsVoice : "";
  const voiceCompatibilityMessage =
    compatibleTtsVoices.length === 0
      ? "当前模型暂无可用音色"
      : selectedTtsVoice
        ? null
        : "请选择可用音色";
  const parsedTurnIdleSeconds = useMemo(
    () => parsePositiveInteger(turnIdleSecondsInput),
    [turnIdleSecondsInput],
  );
  const turnIdleSecondsMessage = parsedTurnIdleSeconds ? null : "请输入正整数秒数";
  const validationMessage = voiceCompatibilityMessage ?? turnIdleSecondsMessage;
  const actionDisabled = busy || Boolean(validationMessage);
  const regionOptions: ChoiceOption[] = useMemo(
    () => [
      { value: "cn", label: "中国大陆" },
      { value: "intl", label: "国际" },
    ],
    [],
  );
  const asrOptions = useMemo(
    () => voiceOptionsWithCurrent(capabilities.asrModels, config.asrModel),
    [capabilities.asrModels, config.asrModel],
  );
  const ttsModelOptions = useMemo(
    () => ttsModelChoices(capabilities.ttsModels, capabilities.ttsVoices, config.ttsModel),
    [capabilities.ttsModels, capabilities.ttsVoices, config.ttsModel],
  );
  const ttsVoiceOptions = useMemo(
    () => voiceOptionsWithCurrent(compatibleTtsVoices, selectedTtsVoice),
    [compatibleTtsVoices, selectedTtsVoice],
  );

  function buildVoiceConfigUpdate(): VoiceConfigUpdate {
    return {
      ...(clearApiKey ? { clearApiKey: true } : {}),
      ...(!clearApiKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      region: config.region,
      asrModel: config.asrModel.trim(),
      ttsModel: config.ttsModel.trim(),
      ttsVoice: config.ttsVoice.trim(),
      turnIdleSeconds: parsedTurnIdleSeconds ?? DEFAULT_CONFIG.turnIdleSeconds,
    };
  }

  async function handleSave() {
    if (busy) return;
    if (validationMessage) {
      setState({ kind: "error", message: validationMessage });
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      setState({ kind: "error", message: "请先连接 Relay 服务器" });
      return;
    }
    const update = buildVoiceConfigUpdate();
    clearSaveFeedbackTimer();
    setState({ kind: "saving" });
    const saveStartedAt = performance.now();
    try {
      const result = await relay.updateVoiceConfig(update);
      const elapsedMs = performance.now() - saveStartedAt;
      if (elapsedMs < MIN_SAVE_PENDING_MS) {
        await sleep(MIN_SAVE_PENDING_MS - elapsedMs);
      }
      if (!result.success || result.error || !result.config) {
        setState({ kind: "error", message: result.error ?? "保存语音设置失败" });
        return;
      }
      setConfig(result.config);
      setTurnIdleSecondsInput(String(result.config.turnIdleSeconds));
      setApiKey("");
      setClearApiKey(false);
      setState({ kind: "saved" });
      saveFeedbackTimerRef.current = setTimeout(() => {
        saveFeedbackTimerRef.current = null;
        setState((current) => (current.kind === "saved" ? { kind: "idle" } : current));
      }, SAVE_SUCCESS_HOLD_MS);
      void relay
        .requestVoiceCapabilities({
          region: result.config.region,
        })
        .then((capabilitiesResult) => {
          if (capabilitiesResult.capabilities) {
            setCapabilities(capabilitiesResult.capabilities);
          }
        })
        .catch(() => {
          setCapabilities(createBundledBailianVoiceCapabilities());
        });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "保存语音设置失败" });
    }
  }

  async function handleTest() {
    if (busy) return;
    if (validationMessage) {
      setState({ kind: "error", message: validationMessage });
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      setState({ kind: "error", message: "请先连接 Relay 服务器" });
      return;
    }
    setState({ kind: "testing" });
    try {
      const result = await relay.testVoiceConfig(buildVoiceConfigUpdate());
      if (!result.success || result.error) {
        setState({ kind: "error", message: result.error ?? "语音配置测试失败" });
        return;
      }
      const playbackMs = playTestAudio(result);
      if (playbackMs > 0) {
        setState({ kind: "playingTest", transcript: result.transcript });
        testPlaybackTimerRef.current = setTimeout(() => {
          testPlaybackTimerRef.current = null;
          setState({ kind: "testPassed", transcript: result.transcript });
        }, playbackMs);
        return;
      }
      setState({ kind: "testPassed", transcript: result.transcript });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "语音配置测试失败" });
    }
  }

  function stopTestPlayback(): void {
    if (testPlaybackTimerRef.current) {
      clearTimeout(testPlaybackTimerRef.current);
      testPlaybackTimerRef.current = null;
    }
    testPlayerRef.current?.stop();
    testPlayerRef.current = null;
    void testAudioContextRef.current?.close();
    testAudioContextRef.current = null;
  }

  function clearSaveFeedbackTimer(): void {
    if (!saveFeedbackTimerRef.current) return;
    clearTimeout(saveFeedbackTimerRef.current);
    saveFeedbackTimerRef.current = null;
  }

  function playTestAudio(result: {
    audioBase64?: string;
    audioSampleRate?: number;
    audioEncoding?: string;
  }): number {
    stopTestPlayback();
    if (!result.audioBase64) return 0;
    if (result.audioEncoding && result.audioEncoding !== "pcm_s16le") {
      throw new Error("测试音频格式暂不支持");
    }
    const sampleRate = result.audioSampleRate ?? 24000;
    const audio = decodeBase64Audio(result.audioBase64);
    if (audio.byteLength === 0) return 0;
    const context = createAudioContext(sampleRate);
    const player = new PcmStreamPlayer(context, sampleRate);
    testAudioContextRef.current = context;
    testPlayerRef.current = player;
    player.enqueue(audio);
    const durationMs = Math.ceil((audio.byteLength / 2 / sampleRate) * 1000);
    return Math.max(MIN_TEST_PLAYBACK_MS, durationMs);
  }

  function firstVoiceForModel(model: string): string {
    return voicesForModel(capabilities.ttsVoices, model)[0]?.value ?? "";
  }

  return (
    <form
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-slot="voice-settings-panel"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <div
        className="flex min-h-0 flex-1 flex-col px-4 py-3 sm:px-5 sm:py-3.5"
        data-slot="voice-settings-body-frame"
      >
        <div
          className="dev-render-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pr-4 sm:pr-1"
          data-slot="voice-settings-scroll"
          ref={scrollRef}
        >
          <div className="space-y-3" data-slot="voice-settings-fields">
            <div className="grid gap-2 rounded-lg border border-border/75 bg-card/55 p-3.5 sm:p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium leading-none text-muted-foreground">
                    服务商
                  </div>
                  <div className="mt-2 truncate text-base font-medium text-foreground md:text-sm">
                    阿里云百炼
                  </div>
                </div>
                <span className="shrink-0 rounded-full border border-primary/35 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                  Bailian
                </span>
              </div>
            </div>

            <FieldBlock
              label="阿里云百炼 API Key"
              help={clearApiKey ? "保存后会清空已保存的 key" : null}
            >
              <div className="flex min-w-0 gap-2">
                <div className="relative min-w-0 flex-1">
                  <KeyRound
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <input
                    aria-label="阿里云百炼 API Key"
                    type="password"
                    name="dev-anywhere-bailian-api-key"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setClearApiKey(false);
                    }}
                    placeholder={
                      clearApiKey
                        ? "保存后清空"
                        : config.configured
                          ? "••••••••••••••••"
                          : "输入 API Key"
                    }
                    className={`${inputClassName} w-full pl-9`}
                  />
                </div>
                {config.configured && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 shrink-0 px-3 md:h-9 md:min-h-0"
                    onClick={() => {
                      setApiKey("");
                      setClearApiKey(true);
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    清空
                  </Button>
                )}
              </div>
            </FieldBlock>

            <ChoiceField
              label="地域"
              value={config.region}
              options={regionOptions}
              onChange={(value) =>
                setConfig((current) => ({
                  ...current,
                  region: value === "intl" ? "intl" : "cn",
                }))
              }
            />

            <ChoiceField
              label="语音识别模型"
              value={config.asrModel}
              options={asrOptions}
              onChange={(value) => setConfig((current) => ({ ...current, asrModel: value }))}
            />

            <ChoiceField
              label="语音合成模型"
              value={config.ttsModel}
              options={ttsModelOptions}
              onChange={(ttsModel) =>
                setConfig((current) => ({
                  ...current,
                  ttsModel,
                  ttsVoice: firstVoiceForModel(ttsModel),
                }))
              }
            />

            <ChoiceField
              label="语音音色"
              value={selectedTtsVoice}
              options={ttsVoiceOptions}
              placeholder={compatibleTtsVoices.length === 0 ? "暂无可用音色" : "请选择音色"}
              onChange={(value) => setConfig((current) => ({ ...current, ttsVoice: value }))}
              help={voiceCompatibilityMessage}
            />

            <FieldBlock label="结束停顿时间（秒）" help={turnIdleSecondsMessage}>
              <input
                aria-label="结束停顿时间（秒）"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={turnIdleSecondsInput}
                onChange={(event) => setTurnIdleSecondsInput(event.target.value)}
                className={`${inputClassName} w-full`}
              />
            </FieldBlock>
          </div>
        </div>
      </div>

      <div
        className="bg-background/95 px-4 pb-3.5 pt-0 backdrop-blur sm:px-5"
        data-slot="voice-settings-footer"
      >
        <div className="mr-4 border-t border-border/70" data-slot="voice-settings-footer-divider" />
        <div className="mt-3.5 flex items-center justify-end gap-2">
          {statusText ? (
            <div
              role={state.kind === "error" ? "alert" : "status"}
              aria-live="polite"
              className={
                state.kind === "error"
                  ? "min-w-0 flex-1 text-sm text-destructive"
                  : "min-w-0 flex-1 text-sm text-muted-foreground"
              }
            >
              {statusText}
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={actionDisabled}
            onClick={() => void handleTest()}
          >
            <Play className="size-4" aria-hidden="true" />
            测试
          </Button>
          <Button type="submit" disabled={actionDisabled}>
            <SaveIcon className="size-4" aria-hidden="true" />
            {state.kind === "saving" ? "保存中..." : "保存"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function decodeBase64Audio(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function createAudioContext(sampleRate: number): AudioContext {
  const audioWindow = window as Window &
    typeof globalThis & { webkitAudioContext?: AudioContextConstructor };
  const Constructor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!Constructor) {
    throw new Error("当前浏览器不支持音频播放");
  }
  return new Constructor({ sampleRate });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function voiceOptionsWithCurrent(options: VoiceOption[], currentValue: string): ChoiceOption[] {
  const mapped = options.map((option) => ({
    value: option.value,
    label: voiceOptionLabel(option),
  }));
  if (!currentValue || mapped.some((option) => option.value === currentValue)) return mapped;
  return [{ value: currentValue, label: currentValue }, ...mapped];
}

function ttsModelChoices(
  models: VoiceOption[],
  voices: VoiceOption[],
  currentValue: string,
): ChoiceOption[] {
  const mapped = models.map((option) => {
    const disabled = voicesForModel(voices, option.value).length === 0;
    return {
      value: option.value,
      label: `${voiceOptionLabel(option)}${disabled ? " · 暂无音色" : ""}`,
      disabled,
    };
  });
  if (!currentValue || mapped.some((option) => option.value === currentValue)) return mapped;
  return [
    {
      value: currentValue,
      label: `${currentValue} · 暂无音色`,
      disabled: true,
    },
    ...mapped,
  ];
}

function splitOptionLabel(label: string): { title: string; detail: string | null } {
  const parts = label
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { title: label, detail: null };
  return { title: parts[0], detail: parts.slice(1).join(" · ") };
}

function voiceOptionLabel(option: VoiceOption): string {
  if (!option.age) return option.label;
  const ageLabel = `年龄 ${option.age}`;
  if (option.label.includes(ageLabel)) return option.label;
  const bareAgeSuffix = ` · ${option.age}`;
  if (option.label.endsWith(bareAgeSuffix)) {
    return `${option.label.slice(0, -bareAgeSuffix.length)} · ${ageLabel}`;
  }
  return `${option.label} · ${ageLabel}`;
}
