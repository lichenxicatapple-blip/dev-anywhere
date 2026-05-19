export function floatToInt16Pcm(samples: Float32Array): Uint8Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    output[i] = sample < 0 ? Math.round(sample * 32768) : Math.floor(sample * 32767);
  }
  return new Uint8Array(output.buffer);
}

export interface PcmCapture {
  stop: () => void;
}

export async function createPcmCapture(
  onChunk: (chunk: Uint8Array) => void,
  options: { sampleRate?: number } = {},
): Promise<PcmCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: options.sampleRate ?? 16000,
    },
  });
  const audioContext = new AudioContext({ sampleRate: options.sampleRate ?? 16000 });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    onChunk(floatToInt16Pcm(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  return {
    stop() {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    },
  };
}
