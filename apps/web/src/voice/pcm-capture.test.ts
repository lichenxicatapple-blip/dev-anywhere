import { afterEach, describe, expect, it, vi } from "vitest";
import { createPcmCapture, floatToInt16Pcm } from "./pcm-capture";

describe("floatToInt16Pcm", () => {
  it("clamps and converts float samples into little-endian 16-bit PCM", () => {
    const pcm = floatToInt16Pcm(new Float32Array([-2, -1, 0, 0.5, 1, 2]));
    expect(Array.from(new Int16Array(pcm.buffer))).toEqual([
      -32768, -32768, 0, 16383, 32767, 32767,
    ]);
  });
});

describe("createPcmCapture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resumes the AudioContext before returning the microphone capture", async () => {
    const stopTrack = vi.fn();
    const disconnectSource = vi.fn();
    const disconnectProcessor = vi.fn();
    const closeContext = vi.fn().mockResolvedValue(undefined);
    const resumeContext = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: stopTrack }],
        })),
      },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        destination = {};
        resume = resumeContext;
        close = closeContext;
        createMediaStreamSource = vi.fn(() => ({
          connect: vi.fn(),
          disconnect: disconnectSource,
        }));
        createScriptProcessor = vi.fn(() => ({
          connect: vi.fn(),
          disconnect: disconnectProcessor,
          onaudioprocess: null,
        }));
      },
    );

    const capture = await createPcmCapture(vi.fn(), { sampleRate: 16000 });

    expect(resumeContext).toHaveBeenCalledTimes(1);
    await capture.stop();
    expect(disconnectProcessor).toHaveBeenCalledTimes(1);
    expect(disconnectSource).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(closeContext).toHaveBeenCalledTimes(1);

    await capture.stop();
    expect(closeContext).toHaveBeenCalledTimes(1);
  });
});
