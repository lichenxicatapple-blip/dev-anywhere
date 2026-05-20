import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceConfigStore } from "./config-store.js";

describe("createVoiceConfigStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "dev-anywhere-voice-config-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns default redacted config when no file exists", () => {
    const store = createVoiceConfigStore({ dataDir });

    expect(store.read()).toEqual({
      provider: "aliyun-bailian",
      configured: false,
      region: "cn",
      asrModel: "qwen3-asr-flash-realtime",
      ttsModel: "cosyvoice-v3-flash",
      ttsVoice: "longanyang",
      turnIdleSeconds: 3,
    });
  });

  it("persists API key but never returns it in read responses", () => {
    const store = createVoiceConfigStore({ dataDir });

    const config = store.update({
      provider: "aliyun-bailian",
      apiKey: "sk-secret",
      region: "intl",
      asrModel: "qwen3-asr-flash-realtime-2026-02-10",
      ttsModel: "cosyvoice-v3-flash",
      ttsVoice: "longanyang",
      turnIdleSeconds: 5,
    });

    expect(config).toEqual({
      provider: "aliyun-bailian",
      configured: true,
      region: "intl",
      asrModel: "qwen3-asr-flash-realtime-2026-02-10",
      ttsModel: "cosyvoice-v3-flash",
      ttsVoice: "longanyang",
      turnIdleSeconds: 5,
    });
    expect(store.read()).not.toHaveProperty("apiKey");
    expect(readFileSync(join(dataDir, "voice-config.json"), "utf8")).toContain("sk-secret");
  });

  it("keeps the existing API key when updating non-secret fields", () => {
    const store = createVoiceConfigStore({ dataDir });
    store.update({ apiKey: "sk-secret" });
    store.update({ ttsVoice: "longxiaochun_v2" });

    expect(store.read()).toMatchObject({
      configured: true,
      ttsVoice: "longxiaochun_v2",
    });
    expect(readFileSync(join(dataDir, "voice-config.json"), "utf8")).toContain("sk-secret");
  });

  it("defaults old config files without voice turn idle timeout", () => {
    const store = createVoiceConfigStore({ dataDir });
    store.update({ apiKey: "sk-secret" });
    const raw = JSON.parse(readFileSync(join(dataDir, "voice-config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    delete raw.turnIdleSeconds;
    const file = join(dataDir, "voice-config.json");
    // Simulate a pre-setting persisted config; the store should migrate it at read time.
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

    expect(store.read().turnIdleSeconds).toBe(3);
    expect(store.readSecret().turnIdleSeconds).toBe(3);
  });

  it("clears the existing API key when requested", () => {
    const store = createVoiceConfigStore({ dataDir });
    store.update({ apiKey: "sk-secret" });

    const config = store.update({ clearApiKey: true });

    expect(config.configured).toBe(false);
    expect(store.readSecret().apiKey).toBeUndefined();
    expect(readFileSync(join(dataDir, "voice-config.json"), "utf8")).not.toContain("sk-secret");
  });

  it("writes the config file with 0600 permissions", () => {
    const store = createVoiceConfigStore({ dataDir });

    store.update({ apiKey: "sk-secret" });

    expect(statSync(join(dataDir, "voice-config.json")).mode & 0o777).toBe(0o600);
  });
});
