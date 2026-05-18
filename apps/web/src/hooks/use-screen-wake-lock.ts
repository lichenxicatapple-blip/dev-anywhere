import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface WakeLockSentinelLike extends EventTarget {
  released: boolean;
  release: () => Promise<void>;
}

interface WakeLockLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: WakeLockLike;
};

interface ScreenWakeLockState {
  active: boolean;
  pending: boolean;
  supported: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  toggle: () => Promise<void>;
}

function wakeLockApi(): WakeLockLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as NavigatorWithWakeLock).wakeLock;
}

function wakeLockErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return "无法开启屏幕常亮";
}

export function useScreenWakeLockScope(scopeKey: string): ScreenWakeLockState {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const scopeGenerationRef = useRef(1);
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const supported = useMemo(() => typeof wakeLockApi()?.request === "function", []);

  const disable = useCallback(async (): Promise<void> => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setActive(false);
    if (!sentinel || sentinel.released) return;
    await sentinel.release();
  }, []);

  const enable = useCallback(async (): Promise<void> => {
    const api = wakeLockApi();
    if (typeof api?.request !== "function") {
      throw new Error("当前浏览器不支持屏幕常亮");
    }

    const generation = scopeGenerationRef.current;
    setPending(true);
    try {
      const sentinel = await api.request("screen");
      if (scopeGenerationRef.current !== generation) {
        await sentinel.release().catch(() => undefined);
        return;
      }
      sentinelRef.current = sentinel;
      sentinel.addEventListener(
        "release",
        () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
          setActive(false);
        },
        { once: true },
      );
      setActive(true);
    } catch (err) {
      if (scopeGenerationRef.current !== generation) return;
      throw new Error(wakeLockErrorMessage(err), { cause: err });
    } finally {
      if (scopeGenerationRef.current === generation) setPending(false);
    }
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    if (active) await disable();
    else await enable();
  }, [active, disable, enable]);

  useEffect(() => {
    const releaseForBackground = (): void => {
      void disable().catch(() => undefined);
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") releaseForBackground();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", releaseForBackground);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", releaseForBackground);
    };
  }, [disable]);

  useEffect(() => {
    return () => {
      scopeGenerationRef.current += 1;
      void disable().catch(() => undefined);
    };
  }, [disable, scopeKey]);

  return { active, pending, supported, enable, disable, toggle };
}
