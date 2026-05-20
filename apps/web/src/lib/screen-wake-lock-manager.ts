export interface WakeLockSentinelLike extends EventTarget {
  released: boolean;
  release: () => Promise<void>;
}

interface WakeLockLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: WakeLockLike;
};

export interface ScreenWakeLockSnapshot {
  active: boolean;
  pending: boolean;
  supported: boolean;
}

interface ScreenWakeLockManagerOptions {
  request?: () => Promise<WakeLockSentinelLike>;
  document?: Document | (EventTarget & { visibilityState?: DocumentVisibilityState });
  window?: Window | EventTarget;
}

type ScopeListener = (snapshot: ScreenWakeLockSnapshot) => void;

function wakeLockApi(): WakeLockLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as NavigatorWithWakeLock).wakeLock;
}

function defaultRequest(): Promise<WakeLockSentinelLike> {
  const api = wakeLockApi();
  if (typeof api?.request !== "function") {
    throw new Error("当前浏览器不支持屏幕常亮");
  }
  return api.request("screen");
}

function wakeLockErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return "无法开启屏幕常亮";
}

export class ScreenWakeLockManager {
  private activeScopes = new Set<string>();
  private pendingScopes = new Set<string>();
  private listeners = new Map<string, Set<ScopeListener>>();
  private sentinel: WakeLockSentinelLike | null = null;
  private requestInFlight: Promise<void> | null = null;
  private requestWakeLock: () => Promise<WakeLockSentinelLike>;
  private documentRef: ScreenWakeLockManagerOptions["document"];
  private windowRef: ScreenWakeLockManagerOptions["window"];
  private supported: boolean;

  constructor(options: ScreenWakeLockManagerOptions = {}) {
    this.requestWakeLock = options.request ?? defaultRequest;
    this.supported =
      typeof options.request === "function" || typeof wakeLockApi()?.request === "function";
    this.documentRef = options.document ?? (typeof document === "undefined" ? undefined : document);
    this.windowRef = options.window ?? (typeof window === "undefined" ? undefined : window);
    this.documentRef?.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.windowRef?.addEventListener("pagehide", this.handlePageHide);
  }

  isSupported(): boolean {
    return this.supported;
  }

  getSnapshot(scopeKey: string): ScreenWakeLockSnapshot {
    return {
      active: this.activeScopes.has(scopeKey),
      pending: this.pendingScopes.has(scopeKey),
      supported: this.isSupported(),
    };
  }

  subscribe(scopeKey: string, listener: ScopeListener): () => void {
    const listeners = this.listeners.get(scopeKey) ?? new Set<ScopeListener>();
    listeners.add(listener);
    this.listeners.set(scopeKey, listeners);
    listener(this.getSnapshot(scopeKey));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(scopeKey);
    };
  }

  async enable(scopeKey: string): Promise<void> {
    this.activeScopes.add(scopeKey);
    this.pendingScopes.add(scopeKey);
    this.notify(scopeKey);
    try {
      await this.ensureWakeLock();
    } catch (err) {
      this.activeScopes.delete(scopeKey);
      throw new Error(wakeLockErrorMessage(err), { cause: err });
    } finally {
      this.pendingScopes.delete(scopeKey);
      this.notify(scopeKey);
    }
  }

  async disable(scopeKey: string): Promise<void> {
    const wasActive = this.activeScopes.delete(scopeKey);
    this.pendingScopes.delete(scopeKey);
    this.notify(scopeKey);
    if (!wasActive || this.activeScopes.size > 0) return;
    await this.releaseSentinel();
  }

  async toggle(scopeKey: string): Promise<void> {
    if (this.activeScopes.has(scopeKey)) await this.disable(scopeKey);
    else await this.enable(scopeKey);
  }

  dispose(): void {
    this.documentRef?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.windowRef?.removeEventListener("pagehide", this.handlePageHide);
    this.activeScopes.clear();
    this.pendingScopes.clear();
    void this.releaseSentinel().catch(() => undefined);
    for (const scopeKey of this.listeners.keys()) this.notify(scopeKey);
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.documentRef?.visibilityState === "hidden") {
      void this.releaseSentinel().catch(() => undefined);
      return;
    }
    if (this.documentRef?.visibilityState === "visible") {
      void this.ensureWakeLock().catch(() => undefined);
    }
  };

  private readonly handlePageHide = (): void => {
    void this.releaseSentinel().catch(() => undefined);
  };

  private async ensureWakeLock(): Promise<void> {
    if (this.activeScopes.size === 0) return;
    if (this.documentRef?.visibilityState === "hidden") return;
    if (this.sentinel && !this.sentinel.released) return;
    if (this.requestInFlight) return this.requestInFlight;

    this.requestInFlight = this.requestWakeLock()
      .then(async (sentinel) => {
        if (this.activeScopes.size === 0 || this.documentRef?.visibilityState === "hidden") {
          if (!sentinel.released) await sentinel.release();
          return;
        }
        this.sentinel = sentinel;
        sentinel.addEventListener(
          "release",
          () => {
            if (this.sentinel === sentinel) this.sentinel = null;
            if (this.activeScopes.size > 0 && this.documentRef?.visibilityState !== "hidden") {
              void this.ensureWakeLock().catch(() => undefined);
            }
          },
          { once: true },
        );
      })
      .finally(() => {
        this.requestInFlight = null;
      });
    return this.requestInFlight;
  }

  private async releaseSentinel(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (!sentinel || sentinel.released) return;
    await sentinel.release();
  }

  private notify(scopeKey: string): void {
    const snapshot = this.getSnapshot(scopeKey);
    this.listeners.get(scopeKey)?.forEach((listener) => listener(snapshot));
  }
}

export const screenWakeLockManager = new ScreenWakeLockManager();
