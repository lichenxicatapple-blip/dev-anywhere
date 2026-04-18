// InputBar 历史栈 hook, per-session, localStorage 持久化 100 条 FIFO
import { useCallback, useMemo, useState } from "react";

const MAX_HISTORY = 100;

function storageKey(sessionId: string): string {
  return `cc_inputHistory:${sessionId}`;
}

function loadHistory(sessionId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((e): e is string => typeof e === "string")
      : [];
  } catch {
    return [];
  }
}

function saveHistory(sessionId: string, history: string[]): void {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(history));
  } catch {
    // 存储配额用尽时静默失败, 不阻止发送
  }
}

export interface InputHistoryApi {
  push: (entry: string) => void;
  recallPrev: () => string | null;
  recallNext: () => string | null;
  reset: () => void;
}

export function useInputHistory(sessionId: string): InputHistoryApi {
  const [history, setHistory] = useState<string[]>(() => loadHistory(sessionId));
  const [index, setIndex] = useState<number>(-1);

  const push = useCallback(
    (entry: string) => {
      const trimmed = entry.trim();
      if (!trimmed) return;
      setHistory((prev) => {
        const next = [...prev, trimmed].slice(-MAX_HISTORY);
        saveHistory(sessionId, next);
        return next;
      });
      setIndex(-1);
    },
    [sessionId],
  );

  const recallPrev = useCallback((): string | null => {
    if (history.length === 0) return null;
    const nextIdx = Math.min(index + 1, history.length - 1);
    setIndex(nextIdx);
    return history[history.length - 1 - nextIdx] ?? null;
  }, [history, index]);

  const recallNext = useCallback((): string | null => {
    if (index <= 0) {
      setIndex(-1);
      return "";
    }
    const nextIdx = index - 1;
    setIndex(nextIdx);
    return history[history.length - 1 - nextIdx] ?? null;
  }, [history, index]);

  const reset = useCallback(() => setIndex(-1), []);

  return useMemo(
    () => ({ push, recallPrev, recallNext, reset }),
    [push, recallPrev, recallNext, reset],
  );
}
