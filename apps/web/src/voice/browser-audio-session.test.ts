import { describe, expect, it } from "vitest";
import { VoiceAudioSessionManager } from "./browser-audio-session";

describe("VoiceAudioSessionManager", () => {
  it("maps voice phases to browser audio routes and restores the original route", () => {
    const session = { type: "auto" };
    const manager = new VoiceAudioSessionManager(() => session);

    const lease = manager.acquire("playback");
    expect(session.type).toBe("playback");

    lease.setMode("capture");
    expect(session.type).toBe("play-and-record");

    lease.release();
    expect(session.type).toBe("auto");
  });

  it("lets the most recently active lease control the route", () => {
    const session = { type: "auto" };
    const manager = new VoiceAudioSessionManager(() => session);
    const capture = manager.acquire("capture");
    const settingsTest = manager.acquire("playback");

    expect(session.type).toBe("playback");

    capture.setMode("capture");
    expect(session.type).toBe("play-and-record");

    capture.release();
    expect(session.type).toBe("playback");

    settingsTest.release();
    expect(session.type).toBe("auto");
  });

  it("is a no-op when the browser does not expose an audio session", () => {
    const manager = new VoiceAudioSessionManager(() => null);
    const lease = manager.acquire("playback");

    expect(() => lease.setMode("capture")).not.toThrow();
    expect(() => lease.release()).not.toThrow();
  });

  it("rolls back a rejected route change", () => {
    let type = "auto";
    let rejectCapture = false;
    const session = {
      get type() {
        return type;
      },
      set type(next: string) {
        if (rejectCapture && next === "play-and-record") return;
        type = next;
      },
    };
    const manager = new VoiceAudioSessionManager(() => session);
    const lease = manager.acquire("playback");
    rejectCapture = true;

    expect(() => lease.setMode("capture")).toThrow("浏览器无法切换语音音频模式");
    expect(session.type).toBe("playback");

    lease.release();
    expect(session.type).toBe("auto");
  });
});
