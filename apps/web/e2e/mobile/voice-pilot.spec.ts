import type { Page } from "@playwright/test";
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay, sentFakeRelayMessages } from "../helpers";

declare global {
  interface Window {
    __devVoiceRuntimeE2E?: {
      resumeCalls: number;
      processorReady: boolean;
      emitMicSamples(samples: number[]): void;
    };
    __devVoiceRuntimeE2EInstalled?: boolean;
    __devAnywhereVoicePilotTurnIdleMs?: number;
  }
}

async function installFakeVoiceRuntime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.__devVoiceRuntimeE2EInstalled) return;
    Object.defineProperty(window, "__devVoiceRuntimeE2EInstalled", {
      configurable: true,
      value: true,
    });

    type FakeAudioProcessEvent = {
      inputBuffer: { getChannelData(channel: number): Float32Array };
    };
    type FakeScriptProcessor = {
      onaudioprocess: ((event: FakeAudioProcessEvent) => void) | null;
      connect(): void;
      disconnect(): void;
    };

    const processors: FakeScriptProcessor[] = [];
    const voiceRuntime = {
      resumeCalls: 0,
      get processorReady() {
        return processors.some((processor) => Boolean(processor.onaudioprocess));
      },
      emitMicSamples(samples: number[]) {
        const processor = processors.at(-1);
        if (!processor?.onaudioprocess) {
          throw new Error("Voice Pilot audio processor is not ready");
        }
        processor.onaudioprocess({
          inputBuffer: {
            getChannelData() {
              return new Float32Array(samples);
            },
          },
        });
      },
    };

    class FakeAudioContext {
      state: AudioContextState = "suspended";
      currentTime = 0;
      sampleRate = 16_000;
      destination = {};

      resume() {
        voiceRuntime.resumeCalls += 1;
        this.state = "running";
        return Promise.resolve();
      }

      suspend() {
        this.state = "suspended";
        return Promise.resolve();
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createScriptProcessor() {
        const processor: FakeScriptProcessor = {
          connect() {},
          disconnect() {},
          onaudioprocess: null,
        };
        processors.push(processor);
        return processor;
      }

      createBuffer(_channels: number, length: number, sampleRate: number) {
        const data = new Float32Array(length);
        return {
          duration: length / sampleRate,
          getChannelData() {
            return data;
          },
        };
      }

      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }

      close() {
        this.state = "closed";
        return Promise.resolve();
      }
    }

    Object.defineProperty(window, "__devVoiceRuntimeE2E", {
      configurable: true,
      value: voiceRuntime,
    });
    Object.defineProperty(window, "__ccTestVoiceActivityClassifierFactory", {
      configurable: true,
      value: async () => ({
        process: () => true,
        reset() {},
        destroy() {},
      }),
    });
    Object.defineProperty(window, "__devAnywhereVoicePilotTurnIdleMs", {
      configurable: true,
      value: 20,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
  });
}

async function openJsonVoicePilot(page: Page, sessionId = "test-sess"): Promise<void> {
  await installFakeVoiceRuntime(page);
  await installFakeRelay(page);
  await page.goto(`${mobileBaseUrl}/#/chat/${sessionId}?mode=json`);
  await page.reload();
  await expect(page.getByLabel("输入聊天消息")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "会话操作" }).click();
  await page.locator('[data-slot="chat-menu-voice-pilot-item"]').click();
  const confirmDialog = page.locator('[data-slot="voice-pilot-wake-lock-dialog"]');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText("开启后会持续聆听并保持屏幕常亮");
  await confirmDialog.getByRole("button", { name: "开启 Voice Pilot" }).click();
  await waitForCaptureReady(page);
}

async function emitSyntheticSpeech(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sampleRate = 16_000;
    const samples = Array.from({ length: 320 * 20 }, (_, index) => {
      const time = index / sampleRate;
      const envelope = Math.min(1, index / 320, (320 * 20 - index) / 320);
      return (
        envelope *
        (0.5 * Math.sin(2 * Math.PI * 140 * time) +
          0.25 * Math.sin(2 * Math.PI * 280 * time) +
          0.15 * Math.sin(2 * Math.PI * 420 * time))
      );
    });
    window.__devVoiceRuntimeE2E?.emitMicSamples(samples);
  });
}

async function waitForCaptureReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          phase: document
            .querySelector('[data-slot="voice-pilot-status"]')
            ?.getAttribute("data-phase"),
          processorReady: window.__devVoiceRuntimeE2E?.processorReady ?? false,
        })),
      { intervals: [100, 100, 100, 100, 250, 250, 500], timeout: 10_000 },
    )
    .toEqual({ phase: "listening", processorReady: true });
}

async function waitForAsrAttempt(page: Page, previousStartCount = 0): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((before) => {
        const starts = (window.__devAnywhereE2E?.voice.asrSent ?? []).filter((raw) => {
          if (typeof raw !== "string") return false;
          try {
            return JSON.parse(raw).type === "start";
          } catch {
            return false;
          }
        }).length;
        return {
          active: window.__devAnywhereE2E?.voice.activeAsrSocketCount() ?? 0,
          started: starts > before,
        };
      }, previousStartCount),
    )
    .toEqual({ active: 1, started: true });
}

async function voicePilotDiagnostics(page: Page, sessionId: string) {
  const sent = await sentFakeRelayMessages(page);
  const snapshot = await page.evaluate((sid) => window.__ccTest?.voice.snapshot(sid), sessionId);
  const messages = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="message-bubble"]')).map((node) => ({
      role: node.getAttribute("data-role"),
      text: node.textContent,
    })),
  );
  return {
    userInputs: sent.filter((item) => item.type === "user_input").length,
    sentTypes: sent.map((item) => item.type).slice(-20),
    snapshot,
    events: await page.evaluate(() => window.__devAnywhereE2E?.events.slice(-40) ?? []),
    messages,
  };
}

async function waitForVoiceUserInput(
  page: Page,
  sessionId: string,
  expectedCount: number,
): Promise<void> {
  await expect
    .poll(() => voicePilotDiagnostics(page, sessionId), {
      timeout: 10_000,
      message: `Voice Pilot should send ${expectedCount} user_input message(s)`,
    })
    .toEqual(expect.objectContaining({ userInputs: expectedCount }));
}

async function emitRecognizedSpeech(page: Page, text: string): Promise<number> {
  const previousStartCount = await page.evaluate(
    () =>
      (window.__devAnywhereE2E?.voice.asrSent ?? []).filter((raw) => {
        if (typeof raw !== "string") return false;
        try {
          return JSON.parse(raw).type === "start";
        } catch {
          return false;
        }
      }).length,
  );
  await emitSyntheticSpeech(page);
  await waitForAsrAttempt(page, previousStartCount);
  return page.evaluate((utterance) => {
    return window.__devAnywhereE2E?.voice.emitAsrFinal(utterance) ?? 0;
  }, text);
}

test.describe("L4 mobile / Voice Pilot", () => {
  test.setTimeout(90_000);

  test("recognized speech sends JSON input without clearing the typed draft", async ({
    emuPage,
  }) => {
    await openJsonVoicePilot(emuPage, "voice-input-sess");
    const input = emuPage.getByLabel("输入聊天消息");
    await input.fill("手动草稿");
    await assertPolishedVoiceStatusPanel(emuPage);

    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          document.querySelector('[data-slot="voice-pilot-status"]')?.getAttribute("data-phase"),
        ),
      )
      .toBe("listening");

    const delivered = await emitRecognizedSpeech(emuPage, "请检查项目状态");
    expect(delivered).toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const sent = await sentFakeRelayMessages(emuPage);
          const msg = sent.find((item) => item.type === "user_input");
          const payload = msg?.payload as { text?: string } | undefined;
          return payload?.text ?? "";
        },
        { timeout: 20_000 },
      )
      .toBe("请检查项目状态");
    await expect(input).toHaveValue("手动草稿");
  });

  test("resumes mobile audio capture and streams microphone PCM to ASR", async ({ emuPage }) => {
    await openJsonVoicePilot(emuPage, "voice-mic-sess");

    await expect
      .poll(() => emuPage.evaluate(() => window.__devVoiceRuntimeE2E?.resumeCalls ?? 0))
      .toBeGreaterThan(0);
    await expect
      .poll(() => emuPage.evaluate(() => window.__devVoiceRuntimeE2E?.processorReady ?? false))
      .toBe(true);

    const before = await emuPage.evaluate(() => window.__devAnywhereE2E?.voice.asrSent.length ?? 0);
    await emitSyntheticSpeech(emuPage);
    await waitForAsrAttempt(emuPage);

    await expect
      .poll(() =>
        emuPage.evaluate(
          (offset) =>
            (window.__devAnywhereE2E?.voice.asrSent ?? []).slice(offset).some((raw) => {
              if (typeof raw === "string" || raw instanceof Blob) return false;
              return raw.byteLength > 0;
            }),
          before,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          Number(
            document
              .querySelector('[data-slot="voice-pilot-waveform"]')
              ?.getAttribute("data-activity-level") ?? "0",
          ),
        ),
      )
      .toBeGreaterThan(18);
  });

  test("keeps listening after a spoken reply and captures a second utterance", async ({
    emuPage,
  }) => {
    await openJsonVoicePilot(emuPage, "voice-second-turn-sess");

    const firstDelivered = await emitRecognizedSpeech(emuPage, "第一轮请求");
    expect(firstDelivered).toBeGreaterThan(0);
    await waitForVoiceUserInput(emuPage, "voice-second-turn-sess", 1);

    await expect
      .poll(() =>
        emuPage.evaluate(() =>
          (window.__devAnywhereE2E?.voice.ttsSent ?? []).some((raw) => {
            try {
              return JSON.parse(raw).type === "speak";
            } catch {
              return false;
            }
          }),
        ),
      )
      .toBe(true);

    const startCountBefore = await emuPage.evaluate(
      () =>
        (window.__devAnywhereE2E?.voice.asrSent ?? []).filter((raw) => {
          if (typeof raw !== "string") return false;
          try {
            return JSON.parse(raw).type === "start";
          } catch {
            return false;
          }
        }).length,
    );
    await emuPage.evaluate(() => {
      window.__devAnywhereE2E?.voice.emitTtsFinished();
    });
    await waitForCaptureReady(emuPage);

    const binaryCountBefore = await emuPage.evaluate(
      () =>
        (window.__devAnywhereE2E?.voice.asrSent ?? []).filter(
          (raw) => typeof raw !== "string" && !(raw instanceof Blob) && raw.byteLength > 0,
        ).length,
    );
    await emitSyntheticSpeech(emuPage);
    await waitForAsrAttempt(emuPage, startCountBefore);
    await expect
      .poll(() =>
        emuPage.evaluate(
          (before) =>
            (window.__devAnywhereE2E?.voice.asrSent ?? []).filter(
              (raw) => typeof raw !== "string" && !(raw instanceof Blob) && raw.byteLength > 0,
            ).length > before,
          binaryCountBefore,
        ),
      )
      .toBe(true);

    const secondDelivered = await emuPage.evaluate(
      () => window.__devAnywhereE2E?.voice.emitAsrFinal("第二轮请求") ?? 0,
    );
    expect(secondDelivered).toBeGreaterThan(0);
    await waitForVoiceUserInput(emuPage, "voice-second-turn-sess", 2);
  });
});

async function assertPolishedVoiceStatusPanel(page: Page): Promise<void> {
  const panel = page.locator('[data-slot="voice-pilot-status"]');
  const stopButton = page.locator('[data-slot="voice-pilot-stop"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-slot="voice-pilot-waveform"]')).toBeVisible();
  await expect(page.locator('[data-slot="voice-pilot-meter-readout"]')).toHaveCount(0);
  await expect(page.locator(".dev-voice-waveform-scan")).toHaveCount(0);
  await expect(stopButton).toHaveText("");

  const layout = await page.evaluate(() => {
    const panelRect = document
      .querySelector('[data-slot="voice-pilot-status"]')
      ?.getBoundingClientRect();
    const stopRect = document
      .querySelector('[data-slot="voice-pilot-stop"]')
      ?.getBoundingClientRect();
    const waveformRect = document
      .querySelector('[data-slot="voice-pilot-waveform"]')
      ?.getBoundingClientRect();
    if (!panelRect || !stopRect || !waveformRect) return null;
    return {
      stopTopDelta: Math.round(stopRect.top - panelRect.top),
      stopRightDelta: Math.round(panelRect.right - stopRect.right),
      waveformStartsBelowStop: waveformRect.top > stopRect.top + 4,
    };
  });
  expect(layout).not.toBeNull();
  expect(layout!.stopTopDelta).toBeGreaterThanOrEqual(8);
  expect(layout!.stopTopDelta).toBeLessThanOrEqual(12);
  expect(layout!.stopRightDelta).toBeGreaterThanOrEqual(6);
  expect(layout!.stopRightDelta).toBeLessThanOrEqual(10);
  expect(layout!.waveformStartsBelowStop).toBe(true);
}
