import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVoicePilotDiagnostics,
  getVoicePilotDiagnostics,
  recordVoicePilotDiagnostic,
} from "./voice-pilot-diagnostics";

describe("voice-pilot-diagnostics", () => {
  beforeEach(() => {
    clearVoicePilotDiagnostics();
  });

  it("exposes structured diagnostics without sharing mutable snapshots", () => {
    recordVoicePilotDiagnostic({
      sessionId: "s1",
      scope: "asr",
      event: "provider-ready",
      attemptId: "attempt-1",
      details: { readyMs: 120 },
    });

    const first = getVoicePilotDiagnostics();
    first[0]!.details!.readyMs = 999;

    expect(getVoicePilotDiagnostics()[0]).toMatchObject({
      sequence: 1,
      sessionId: "s1",
      scope: "asr",
      event: "provider-ready",
      attemptId: "attempt-1",
      details: { readyMs: 120 },
    });
    expect(window.__devAnywhereVoicePilotDiagnostics?.snapshot()).toHaveLength(1);
  });

  it("keeps a bounded tail", () => {
    for (let index = 0; index < 410; index += 1) {
      recordVoicePilotDiagnostic({
        sessionId: "s1",
        scope: "runtime",
        event: `event-${index}`,
      });
    }

    const snapshot = getVoicePilotDiagnostics();
    expect(snapshot).toHaveLength(400);
    expect(snapshot[0]?.event).toBe("event-10");
    expect(snapshot.at(-1)?.event).toBe("event-409");
  });
});
