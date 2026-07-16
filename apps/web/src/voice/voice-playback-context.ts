type AudioContextFactory = () => AudioContext;

function createBrowserAudioContext(): AudioContext {
  return new AudioContext();
}

export class VoicePlaybackContextManager {
  private context: AudioContext | null = null;

  constructor(private readonly createContext: AudioContextFactory = createBrowserAudioContext) {}

  get(): AudioContext {
    this.context ??= this.createContext();
    return this.context;
  }

  async prepare(): Promise<AudioContext> {
    const context = this.get();
    if (context.state !== "running" && context.state !== "closed") {
      await context.resume();
    }
    if (context.state !== "running") {
      throw new Error("浏览器未允许播放 Voice Pilot 提示音");
    }
    return context;
  }

  async reactivateAfterCapture(): Promise<AudioContext> {
    const context = this.get();
    if (context.state === "closed") {
      throw new Error("Voice Pilot 播放上下文已关闭");
    }
    if (context.state === "running") {
      await context.suspend();
    }
    if (context.state !== "running") {
      await context.resume();
    }
    if (context.state !== "running") {
      throw new Error("浏览器未能恢复 Voice Pilot 音频输出");
    }
    return context;
  }
}

export const voicePlaybackContext = new VoicePlaybackContextManager();
