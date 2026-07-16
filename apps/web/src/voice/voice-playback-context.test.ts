import { describe, expect, it, vi } from "vitest";
import { VoicePlaybackContextManager } from "./voice-playback-context";

describe("VoicePlaybackContextManager", () => {
  it("creates one context and resumes it from the caller's activation gesture", async () => {
    const rawContext = { state: "suspended" };
    const resume = vi.fn(async () => {
      rawContext.state = "running";
    });
    const context = { ...rawContext, resume } as unknown as AudioContext;
    Object.defineProperty(context, "state", {
      get: () => rawContext.state,
    });
    const createContext = vi.fn(() => context);
    const manager = new VoicePlaybackContextManager(createContext);

    await expect(manager.prepare()).resolves.toBe(context);
    expect(manager.get()).toBe(context);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("fails instead of pretending a suspended context played a cue", async () => {
    const context = {
      state: "suspended",
      resume: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext;
    const manager = new VoicePlaybackContextManager(() => context);

    await expect(manager.prepare()).rejects.toThrow("浏览器未允许播放 Voice Pilot 提示音");
  });

  it("reattaches a running playback context after microphone capture ends", async () => {
    const calls: string[] = [];
    let state = "running";
    const context = {
      get state() {
        return state;
      },
      async suspend() {
        calls.push("suspend");
        state = "suspended";
      },
      async resume() {
        calls.push("resume");
        state = "running";
      },
    } as unknown as AudioContext;
    const manager = new VoicePlaybackContextManager(() => context);

    await expect(manager.reactivateAfterCapture()).resolves.toBe(context);
    expect(calls).toEqual(["suspend", "resume"]);
  });
});
