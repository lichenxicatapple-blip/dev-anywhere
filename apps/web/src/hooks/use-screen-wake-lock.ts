import { useCallback, useEffect, useState } from "react";
import { screenWakeLockManager, type ScreenWakeLockSnapshot } from "@/lib/screen-wake-lock-manager";

interface ScreenWakeLockState extends ScreenWakeLockSnapshot {
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  toggle: () => Promise<void>;
}

export function useScreenWakeLockScope(scopeKey: string): ScreenWakeLockState {
  const [snapshot, setSnapshot] = useState<ScreenWakeLockSnapshot>(() =>
    screenWakeLockManager.getSnapshot(scopeKey),
  );

  useEffect(() => {
    return screenWakeLockManager.subscribe(scopeKey, setSnapshot);
  }, [scopeKey]);

  useEffect(() => {
    return () => {
      void screenWakeLockManager.disable(scopeKey).catch(() => undefined);
    };
  }, [scopeKey]);

  const enable = useCallback(() => screenWakeLockManager.enable(scopeKey), [scopeKey]);
  const disable = useCallback(() => screenWakeLockManager.disable(scopeKey), [scopeKey]);
  const toggle = useCallback(() => screenWakeLockManager.toggle(scopeKey), [scopeKey]);

  return {
    ...snapshot,
    enable,
    disable,
    toggle,
  };
}
