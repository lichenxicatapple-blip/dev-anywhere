import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type VoicePilotPhase =
  | "idle"
  | "starting"
  | "listening"
  | "drafting"
  | "submitting"
  | "waiting"
  | "summarizing"
  | "speaking"
  | "approval"
  | "paused"
  | "error";

export interface VoicePilotState {
  enabled: boolean;
  phase: VoicePilotPhase;
  error: string | null;
  lastSpokenText: string;
  approvalRequestId: string | null;
  activityLevel: number;
  draft: string;
  partial: string;
}

interface VoicePilotStoreState {
  bySessionId: Record<string, VoicePilotState>;
  enable: (sessionId: string) => void;
  disable: (sessionId: string) => void;
  setPhase: (sessionId: string, phase: VoicePilotPhase) => void;
  setError: (sessionId: string, error: string) => void;
  clearError: (sessionId: string) => void;
  setLastSpokenText: (sessionId: string, text: string) => void;
  setApproval: (sessionId: string, requestId: string | null) => void;
  setActivityLevel: (sessionId: string, level: number) => void;
  setDraft: (sessionId: string, draft: string) => void;
  setPartial: (sessionId: string, partial: string) => void;
  resetAll: () => void;
}

export const DEFAULT_VOICE_PILOT_STATE: VoicePilotState = {
  enabled: false,
  phase: "idle",
  error: null,
  lastSpokenText: "",
  approvalRequestId: null,
  activityLevel: 0,
  draft: "",
  partial: "",
};

function clampActivityLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(1, level));
}

function ensureSession(
  state: VoicePilotStoreState,
  sessionId: string,
  update: (current: VoicePilotState) => VoicePilotState,
): Partial<VoicePilotStoreState> {
  const current = state.bySessionId[sessionId] ?? DEFAULT_VOICE_PILOT_STATE;
  return {
    bySessionId: {
      ...state.bySessionId,
      [sessionId]: update(current),
    },
  };
}

export const useVoicePilotStore = create<VoicePilotStoreState>()(
  devtools(
    (set) => ({
      bySessionId: {},

      enable: (sessionId) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            enabled: true,
            phase: "listening",
            error: null,
          })),
        ),

      disable: (sessionId) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            enabled: false,
            phase: "idle",
            error: null,
            approvalRequestId: null,
            activityLevel: 0,
            draft: "",
            partial: "",
          })),
        ),

      setPhase: (sessionId, phase) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            phase,
            error: phase === "error" ? current.error : null,
          })),
        ),

      setError: (sessionId, error) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            phase: "error",
            error,
            activityLevel: 0,
          })),
        ),

      clearError: (sessionId) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            error: null,
            phase: current.enabled ? "listening" : "idle",
          })),
        ),

      setLastSpokenText: (sessionId, text) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            lastSpokenText: text,
          })),
        ),

      setApproval: (sessionId, requestId) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            approvalRequestId: requestId,
            phase: requestId ? "approval" : current.enabled ? "listening" : "idle",
          })),
        ),

      setActivityLevel: (sessionId, level) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            activityLevel: clampActivityLevel(level),
          })),
        ),

      setDraft: (sessionId, draft) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            draft,
          })),
        ),

      setPartial: (sessionId, partial) =>
        set((state) =>
          ensureSession(state, sessionId, (current) => ({
            ...current,
            partial,
          })),
        ),

      resetAll: () => set({ bySessionId: {} }),
    }),
    { name: "voice-pilot-store" },
  ),
);
