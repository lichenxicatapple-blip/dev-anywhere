import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadRelayRuntimeEnv } from "../../runtime-env.js";

describe("loadRelayRuntimeEnv", () => {
  it("uses defaults when env is empty", () => {
    const env = loadRelayRuntimeEnv({});
    expect(env.port).toBe(3100);
    expect(env.heartbeatInterval).toBe(30000);
    expect(env.logLevel).toBe("info");
    expect(env.dataDir).toBe(`${homedir()}/.dev-anywhere/relay-data`);
    expect(env.proxyToken).toBeUndefined();
    expect(env.clientToken).toBeUndefined();
    expect(env.chaos.enabled).toBe(false);
    expect(env.voiceDefaults).toEqual({});
  });

  it("honors empty DATA_DIR as 'persistence disabled'", () => {
    const env = loadRelayRuntimeEnv({ DATA_DIR: "" });
    expect(env.dataDir).toBeUndefined();
  });

  it("trims empty token strings to undefined", () => {
    const env = loadRelayRuntimeEnv({ RELAY_PROXY_TOKEN: "", RELAY_CLIENT_TOKEN: "" });
    expect(env.proxyToken).toBeUndefined();
    expect(env.clientToken).toBeUndefined();
  });

  it("rejects out-of-range PORT", () => {
    expect(() => loadRelayRuntimeEnv({ PORT: "0" })).toThrow(/TCP port/);
    expect(() => loadRelayRuntimeEnv({ PORT: "99999" })).toThrow(/TCP port/);
    expect(() => loadRelayRuntimeEnv({ PORT: "abc" })).toThrow(/TCP port/);
  });

  it("rejects non-positive HEARTBEAT_INTERVAL", () => {
    expect(() => loadRelayRuntimeEnv({ HEARTBEAT_INTERVAL: "0" })).toThrow(/positive integer/);
    expect(() => loadRelayRuntimeEnv({ HEARTBEAT_INTERVAL: "-1" })).toThrow(/positive integer/);
  });

  it("forwards chaos env unchanged", () => {
    const env = loadRelayRuntimeEnv({
      DEV_ANYWHERE_RELAY_CHAOS: "1",
      DEV_ANYWHERE_RELAY_CHAOS_DELAY_MS: "50",
    });
    expect(env.chaos.enabled).toBe(true);
    expect(env.chaos.delayMs).toBe(50);
  });

  it("reads optional Bailian voice defaults", () => {
    const env = loadRelayRuntimeEnv({
      BAILIAN_REGION: "intl",
      BAILIAN_ASR_MODEL: "qwen3-asr-flash-realtime-2026-02-10",
      BAILIAN_TTS_MODEL: "cosyvoice-v3-flash",
      BAILIAN_TTS_VOICE: "longanyang",
    });

    expect(env.voiceDefaults).toEqual({
      region: "intl",
      asrModel: "qwen3-asr-flash-realtime-2026-02-10",
      ttsModel: "cosyvoice-v3-flash",
      ttsVoice: "longanyang",
    });
  });
});
