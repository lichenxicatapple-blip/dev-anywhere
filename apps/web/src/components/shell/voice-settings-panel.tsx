import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  VoiceCapabilities,
  VoiceConfigUpdate,
  VoiceOption,
  VoiceProviderConfig,
} from "@dev-anywhere/shared";
import { createBundledBailianVoiceCapabilities } from "@dev-anywhere/shared";
import { ChevronDown, Play, Save as SaveIcon } from "lucide-react";
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

const selectClassName =
  "min-h-11 min-w-0 appearance-none rounded-md border border-border bg-input px-3 pr-12 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-h-0 md:text-sm";
const MIN_TEST_PLAYBACK_MS = 800;
const MIN_SAVE_PENDING_MS = 300;
const SAVE_SUCCESS_HOLD_MS = 1600;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function SelectShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-w-0">
      {children}
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

function voicesForModel(voices: VoiceOption[], model: string): VoiceOption[] {
  return voices.filter((voice) => !voice.model || voice.model === model);
}

export function VoiceSettingsPanel() {
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
      setState({ kind: "error", message: "请先连接 Relay" });
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
      setState({ kind: "error", message: "请先连接 Relay" });
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
      setState({ kind: "error", message: "请先连接 Relay" });
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

  function renderOptions(options: VoiceOption[], currentValue: string) {
    const hasCurrent = options.some((option) => option.value === currentValue);
    return (
      <>
        {!hasCurrent && currentValue ? <option value={currentValue}>{currentValue}</option> : null}
        {options.map((option) => (
          <option key={`${option.source}:${option.value}`} value={option.value}>
            {voiceOptionLabel(option)}
          </option>
        ))}
      </>
    );
  }

  function firstVoiceForModel(model: string): string {
    return voicesForModel(capabilities.ttsVoices, model)[0]?.value ?? "";
  }

  function renderTtsModelOptions(currentValue: string) {
    const hasCurrent = capabilities.ttsModels.some((option) => option.value === currentValue);
    return (
      <>
        {!hasCurrent && currentValue ? (
          <option value={currentValue} disabled>
            {currentValue} · 暂无音色
          </option>
        ) : null}
        {capabilities.ttsModels.map((option) => {
          const disabled = voicesForModel(capabilities.ttsVoices, option.value).length === 0;
          return (
            <option
              key={`${option.source}:${option.value}`}
              value={option.value}
              disabled={disabled}
            >
              {voiceOptionLabel(option)}
              {disabled ? " · 暂无音色" : ""}
            </option>
          );
        })}
      </>
    );
  }

  function renderTtsVoiceOptions(options: VoiceOption[]) {
    return options.map((option) => (
      <option
        key={`${option.source}:${option.model ?? "any"}:${option.value}`}
        value={option.value}
      >
        {voiceOptionLabel(option)}
      </option>
    ));
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      data-slot="voice-settings-panel"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <p className="text-sm text-muted-foreground">
        连接语音服务后，即可以语音交互的形式驱动会话。
      </p>

      <div className="rounded-md border border-border bg-card/70 p-3">
        <div className="text-xs text-muted-foreground">服务商</div>
        <div className="mt-1 text-sm font-medium text-foreground">阿里云百炼</div>
      </div>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">阿里云百炼 API Key</span>
        <div className="flex min-w-0 gap-2">
          <input
            type="password"
            name="dev-anywhere-bailian-api-key"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setClearApiKey(false);
            }}
            placeholder={
              clearApiKey ? "保存后清空" : config.configured ? "••••••••••••••••" : "输入 API Key"
            }
            className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-input px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-h-0 md:text-sm"
          />
          {config.configured && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0 md:h-9 md:min-h-0"
              onClick={() => {
                setApiKey("");
                setClearApiKey(true);
              }}
            >
              清空
            </Button>
          )}
        </div>
        {clearApiKey && (
          <span className="text-xs text-muted-foreground">保存后会清空已保存的 key</span>
        )}
      </label>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">地域</span>
        <SelectShell>
          <select
            value={config.region}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                region: event.target.value === "intl" ? "intl" : "cn",
              }))
            }
            className={`${selectClassName} w-full`}
          >
            <option value="cn">中国大陆</option>
            <option value="intl">国际</option>
          </select>
        </SelectShell>
      </label>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">语音识别模型</span>
        <SelectShell>
          <select
            value={config.asrModel}
            onChange={(event) =>
              setConfig((current) => ({ ...current, asrModel: event.target.value }))
            }
            className={`${selectClassName} w-full font-mono`}
          >
            {renderOptions(capabilities.asrModels, config.asrModel)}
          </select>
        </SelectShell>
      </label>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">语音合成模型</span>
        <SelectShell>
          <select
            value={config.ttsModel}
            onChange={(event) => {
              const ttsModel = event.target.value;
              setConfig((current) => ({
                ...current,
                ttsModel,
                ttsVoice: firstVoiceForModel(ttsModel),
              }));
            }}
            className={`${selectClassName} w-full font-mono`}
          >
            {renderTtsModelOptions(config.ttsModel)}
          </select>
        </SelectShell>
      </label>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">语音音色</span>
        <SelectShell>
          <select
            value={selectedTtsVoice}
            onChange={(event) =>
              setConfig((current) => ({ ...current, ttsVoice: event.target.value }))
            }
            disabled={compatibleTtsVoices.length === 0}
            className={`${selectClassName} w-full font-mono`}
          >
            {!selectedTtsVoice ? (
              <option value="" disabled>
                {compatibleTtsVoices.length === 0 ? "暂无可用音色" : "请选择音色"}
              </option>
            ) : null}
            {renderTtsVoiceOptions(compatibleTtsVoices)}
          </select>
        </SelectShell>
        {voiceCompatibilityMessage ? (
          <span className="text-xs text-muted-foreground">{voiceCompatibilityMessage}</span>
        ) : null}
      </label>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">结束停顿时间（秒）</span>
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={turnIdleSecondsInput}
          onChange={(event) => setTurnIdleSecondsInput(event.target.value)}
          className="min-h-11 min-w-0 rounded-md border border-border bg-input px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-h-0 md:text-sm"
        />
        {turnIdleSecondsMessage ? (
          <span className="text-xs text-muted-foreground">{turnIdleSecondsMessage}</span>
        ) : null}
      </label>

      <div className="flex items-center justify-end gap-3">
        {statusText ? (
          <div
            role={state.kind === "error" ? "alert" : "status"}
            aria-live="polite"
            className={
              state.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
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
