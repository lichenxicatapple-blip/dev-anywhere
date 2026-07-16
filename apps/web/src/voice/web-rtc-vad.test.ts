import { describe, expect, it } from "vitest";
import { PcmFrameSlicer, VoiceActivityGate, WEB_RTC_VAD_FRAME_SAMPLES } from "./web-rtc-vad";

describe("VoiceActivityGate", () => {
  it("requires sustained speech and ignores short noise", () => {
    const gate = new VoiceActivityGate();
    expect(Array.from({ length: 9 }, () => gate.push(true))).not.toContain("speech-start");
    expect(gate.push(false)).toBe("none");
    expect(Array.from({ length: 9 }, () => gate.push(true))).not.toContain("speech-start");
    expect(gate.push(true)).toBe("speech-start");
  });

  it("ends a turn after 600 ms of detected silence", () => {
    const gate = new VoiceActivityGate();
    for (let index = 0; index < 10; index += 1) gate.push(true);
    expect(Array.from({ length: 29 }, () => gate.push(false))).not.toContain("speech-end");
    expect(gate.push(false)).toBe("speech-end");
  });
});

describe("PcmFrameSlicer", () => {
  it("emits exact 20 ms frames while preserving callback boundaries", () => {
    const slicer = new PcmFrameSlicer();
    const frames: Float32Array[] = [];
    slicer.push(new Float32Array(WEB_RTC_VAD_FRAME_SAMPLES - 10).fill(1), (frame) =>
      frames.push(frame),
    );
    slicer.push(new Float32Array(WEB_RTC_VAD_FRAME_SAMPLES + 20).fill(2), (frame) =>
      frames.push(frame),
    );
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.length === WEB_RTC_VAD_FRAME_SAMPLES)).toBe(true);
    expect(Array.from(frames[0]?.slice(-10) ?? [])).toEqual(Array(10).fill(2));
  });
});
