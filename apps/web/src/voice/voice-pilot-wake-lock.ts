export function voicePilotWakeLockScopeKey(sessionId: string): string {
  return `voice-pilot:${sessionId}`;
}
