export interface PtyKeepAliveEntry {
  sessionId: string;
  touchedAt: number;
}

interface TouchPtyKeepAliveEntryOptions {
  capacity: number;
  now: number;
  activeSessionId: string | null;
}

export function touchPtyKeepAliveEntry(
  entries: PtyKeepAliveEntry[],
  sessionId: string,
  options: TouchPtyKeepAliveEntryOptions,
): PtyKeepAliveEntry[] {
  const next = entries.some((entry) => entry.sessionId === sessionId)
    ? entries.map((entry) =>
        entry.sessionId === sessionId ? { ...entry, touchedAt: options.now } : entry,
      )
    : [...entries, { sessionId, touchedAt: options.now }];

  if (next.length <= options.capacity) return next;

  const evictable = next
    .filter((entry) => entry.sessionId !== options.activeSessionId)
    .sort((a, b) => a.touchedAt - b.touchedAt)[0];
  if (!evictable) return next.slice(-options.capacity);
  return next.filter((entry) => entry.sessionId !== evictable.sessionId);
}

export function removePtyKeepAliveEntry(
  entries: PtyKeepAliveEntry[],
  sessionId: string,
): PtyKeepAliveEntry[] {
  return entries.filter((entry) => entry.sessionId !== sessionId);
}
