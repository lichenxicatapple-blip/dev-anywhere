export type VoicePilotDiagnosticScope =
  | "runtime"
  | "state-machine"
  | "asr"
  | "capture"
  | "tts"
  | "playback"
  | "audio-session";

export type VoicePilotDiagnosticDetails = Record<string, string | number | boolean | null>;

export interface VoicePilotDiagnosticEvent {
  sequence: number;
  timestamp: string;
  monotonicMs: number;
  sessionId: string;
  scope: VoicePilotDiagnosticScope;
  event: string;
  attemptId?: string;
  requestId?: string;
  details?: VoicePilotDiagnosticDetails;
}

export interface VoicePilotDiagnosticInput {
  sessionId: string;
  scope: VoicePilotDiagnosticScope;
  event: string;
  attemptId?: string | null;
  requestId?: string | null;
  details?: VoicePilotDiagnosticDetails;
}

export interface VoicePilotDiagnosticsApi {
  snapshot(): VoicePilotDiagnosticEvent[];
  clear(): void;
}

declare global {
  interface Window {
    __devAnywhereVoicePilotDiagnostics?: VoicePilotDiagnosticsApi;
  }
}

const MAX_EVENTS = 400;
const events: VoicePilotDiagnosticEvent[] = [];
let nextSequence = 1;

function monotonicNow(): number {
  return typeof performance === "undefined" ? 0 : Math.round(performance.now() * 10) / 10;
}

export function recordVoicePilotDiagnostic(input: VoicePilotDiagnosticInput): void {
  const entry: VoicePilotDiagnosticEvent = {
    sequence: nextSequence++,
    timestamp: new Date().toISOString(),
    monotonicMs: monotonicNow(),
    sessionId: input.sessionId,
    scope: input.scope,
    event: input.event,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.details ? { details: { ...input.details } } : {}),
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

export function getVoicePilotDiagnostics(): VoicePilotDiagnosticEvent[] {
  return events.map((entry) => ({
    ...entry,
    ...(entry.details ? { details: { ...entry.details } } : {}),
  }));
}

export function clearVoicePilotDiagnostics(): void {
  events.length = 0;
  nextSequence = 1;
}

if (typeof window !== "undefined") {
  window.__devAnywhereVoicePilotDiagnostics = {
    snapshot: getVoicePilotDiagnostics,
    clear: clearVoicePilotDiagnostics,
  };
}
