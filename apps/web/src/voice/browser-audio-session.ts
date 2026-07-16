export type VoiceAudioSessionMode = "playback" | "capture";

export interface VoiceAudioSessionLease {
  setMode(mode: VoiceAudioSessionMode): void;
  release(): void;
}

interface BrowserAudioSession {
  type: string;
}

interface LeaseState {
  mode: VoiceAudioSessionMode;
  order: number;
}

const NATIVE_MODE: Record<VoiceAudioSessionMode, string> = {
  playback: "playback",
  capture: "play-and-record",
};

function currentBrowserAudioSession(): BrowserAudioSession | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { audioSession?: BrowserAudioSession }).audioSession ?? null;
}

function noopLease(): VoiceAudioSessionLease {
  return {
    setMode: () => undefined,
    release: () => undefined,
  };
}

export class VoiceAudioSessionManager {
  private readonly leases = new Map<number, LeaseState>();
  private session: BrowserAudioSession | null = null;
  private baselineType: string | null = null;
  private nextLeaseId = 1;
  private nextOrder = 1;

  constructor(
    private readonly getAudioSession: () => BrowserAudioSession | null = currentBrowserAudioSession,
  ) {}

  acquire(initialMode: VoiceAudioSessionMode): VoiceAudioSessionLease {
    const session = this.getAudioSession();
    if (!session) return noopLease();

    if (this.leases.size === 0) {
      this.session = session;
      this.baselineType = session.type;
    }

    const leaseId = this.nextLeaseId++;
    this.leases.set(leaseId, { mode: initialMode, order: this.nextOrder++ });
    try {
      this.applyActiveMode();
    } catch (error) {
      this.leases.delete(leaseId);
      if (this.leases.size === 0) {
        this.restoreWhenUnused();
      } else {
        this.applyActiveModeBestEffort();
      }
      throw error;
    }

    let released = false;
    return {
      setMode: (mode) => {
        if (released) return;
        const lease = this.leases.get(leaseId);
        if (!lease) return;
        const previous = { ...lease };
        lease.mode = mode;
        lease.order = this.nextOrder++;
        try {
          this.applyActiveMode();
        } catch (error) {
          this.leases.set(leaseId, previous);
          this.applyActiveModeBestEffort();
          throw error;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(leaseId);
        if (this.leases.size === 0) {
          this.restoreWhenUnused();
          return;
        }
        this.applyActiveModeBestEffort();
      },
    };
  }

  private applyActiveMode(): void {
    const active = [...this.leases.values()].reduce<LeaseState | null>(
      (latest, lease) => (!latest || lease.order > latest.order ? lease : latest),
      null,
    );
    if (!active || !this.session) return;
    this.setNativeType(NATIVE_MODE[active.mode]);
  }

  private applyActiveModeBestEffort(): void {
    try {
      this.applyActiveMode();
    } catch {
      // Resource cleanup must remain safe even if the browser rejects a route change.
    }
  }

  private restoreWhenUnused(): void {
    const session = this.session;
    const baselineType = this.baselineType;
    this.session = null;
    this.baselineType = null;
    if (!session || baselineType === null) return;
    try {
      session.type = baselineType;
    } catch {
      // The page is already releasing the resource; there is no useful recovery here.
    }
  }

  private setNativeType(type: string): void {
    if (!this.session || this.session.type === type) return;
    try {
      this.session.type = type;
    } catch {
      throw new Error("浏览器无法切换语音音频模式");
    }
    if (this.session.type !== type) {
      throw new Error("浏览器无法切换语音音频模式");
    }
  }
}

export const voiceAudioSession = new VoiceAudioSessionManager();
