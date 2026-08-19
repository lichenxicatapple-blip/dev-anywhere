export interface PtyKeepAliveEntry {
  sessionId: string;
}

export function touchPtyKeepAliveEntry(
  entries: PtyKeepAliveEntry[],
  sessionId: string,
): PtyKeepAliveEntry[] {
  if (entries.some((entry) => entry.sessionId === sessionId)) return entries;
  return [...entries, { sessionId }];
}

export function removePtyKeepAliveEntry(
  entries: PtyKeepAliveEntry[],
  sessionId: string,
): PtyKeepAliveEntry[] {
  return entries.filter((entry) => entry.sessionId !== sessionId);
}
