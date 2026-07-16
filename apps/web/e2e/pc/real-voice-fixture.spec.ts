import { expect, test, type Page } from "@playwright/test";
import { installWakeLockMock } from "../wake-lock-test-helper";

const enabled = process.env.DEV_ANYWHERE_REAL_VOICE_FIXTURE_SMOKE === "1";
const sessionId = process.env.DEV_ANYWHERE_VOICE_FIXTURE_SESSION_ID ?? "";
const FIRST_LISTENING_BUDGET_MS = 55_000;

interface VoiceDiagnosticEvent {
  scope: string;
  event: string;
  monotonicMs?: number;
  attemptId?: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

test.describe("real Voice Pilot fixture", () => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_VOICE_FIXTURE_SMOKE=1 to use the real voice stack");
  test.skip(!sessionId, "set DEV_ANYWHERE_VOICE_FIXTURE_SESSION_ID to a dedicated JSON session");

  test("runs the fixed recording through VAD, ASR, Agent, and TTS", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    await installWakeLockMock(page);

    await page.goto("/?voice-fixture=default#/sessions");
    await selectFirstProxy(page);
    await page.goto(`/?voice-fixture=default#/chat/${sessionId}?mode=json`);
    await expect(page.getByLabel("输入聊天消息")).toBeVisible({ timeout: 30_000 });

    const coldStartup = await startVoicePilot(page);
    expect(coldStartup.clickToListeningMs).toBeLessThan(FIRST_LISTENING_BUDGET_MS);
    await testInfo.attach("voice-startup-cold.json", {
      body: JSON.stringify(coldStartup, null, 2),
      contentType: "application/json",
    });
    console.log(`Voice Pilot cold startup: ${JSON.stringify(coldStartup)}`);

    // This fixture contains more than nine seconds of leading silence. Silence must
    // stay local instead of opening a Provider connection and building a Relay backlog.
    await page.waitForTimeout(6_000);
    expect((await voiceEvents(page)).some(isAsrAttemptStart)).toBe(false);

    await expect
      .poll(async () => (await voiceEvents(page)).some(isAsrAttemptStart), {
        timeout: 20_000,
      })
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await voiceEvents(page)).some(
            (event) => event.scope === "asr" && event.event === "provider-ready",
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await voiceEvents(page)).some(
            (event) => event.scope === "asr" && event.event === "final-received",
          ),
        { timeout: 40_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await voiceEvents(page)).some(
            (event) => event.scope === "runtime" && event.event === "user-text-submitted",
          ),
        { timeout: 45_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await voiceEvents(page)).some(
            (event) =>
              event.scope === "runtime" &&
              event.event === "assistant-text-queued" &&
              typeof event.details?.messageId === "string" &&
              event.details.messageId.length > 0,
          ),
        { timeout: 180_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await voiceEvents(page)).some(
            (event) => event.scope === "tts" && event.event === "first-pcm-received",
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await voiceEvents(page)).some(
            (event) => event.scope === "tts" && event.event === "provider-finished",
          ),
        { timeout: 60_000 },
      )
      .toBe(true);

    const events = await voiceEvents(page);
    expect(
      events.filter(
        (event) =>
          (event.scope === "asr" && event.event === "attempt-error") ||
          (event.scope === "tts" && event.event === "provider-error"),
      ),
    ).toEqual([]);

    const stop = page.locator('[data-slot="voice-pilot-stop"]');
    if (await stop.isVisible()) await stop.click();
    await expect(stop).toBeHidden();

    const warmStartup = await startVoicePilot(page);
    expect(warmStartup.clickToListeningMs).toBeLessThan(FIRST_LISTENING_BUDGET_MS);
    await testInfo.attach("voice-startup-warm.json", {
      body: JSON.stringify(warmStartup, null, 2),
      contentType: "application/json",
    });
    console.log(`Voice Pilot warm startup: ${JSON.stringify(warmStartup)}`);
    await page.locator('[data-slot="voice-pilot-stop"]').click();
    await expect(page.locator('[data-slot="voice-pilot-stop"]')).toBeHidden();
  });
});

interface VoiceResourceMetric {
  name: string;
  durationMs: number;
  responseEndMs: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  initiatorType: string;
}

interface VoiceStartupMetric {
  clickToListeningMs: number;
  startedAtMs: number;
  listeningAtMs: number;
  resources: VoiceResourceMetric[];
}

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  if (await switcher.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await switcher.click();
  } else {
    await page.goto("/?voice-fixture=default#/");
  }
  const proxy = page.locator('[data-slot="proxy-item"][data-online="true"]:visible').first();
  await expect(proxy).toBeVisible({ timeout: 30_000 });
  await proxy.click();
}

async function voiceEvents(page: Page): Promise<VoiceDiagnosticEvent[]> {
  return page.evaluate(
    () => (window.__devAnywhereVoicePilotDiagnostics?.snapshot() ?? []) as VoiceDiagnosticEvent[],
  );
}

async function startVoicePilot(page: Page): Promise<VoiceStartupMetric> {
  await page.evaluate(() => window.__devAnywhereVoicePilotDiagnostics?.clear());
  await page.locator('[data-slot="chat-overflow-trigger"]').click();
  await page.locator('[data-slot="chat-menu-voice-pilot-item"]').click();
  const confirmation = page.locator('[data-slot="voice-pilot-wake-lock-dialog"]');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "开启 Voice Pilot" }).click();

  await expect
    .poll(
      async () => {
        const events = await voiceEvents(page);
        return events.some(
          (event) =>
            (event.scope === "capture" && event.event === "listening") ||
            event.event === "startup-failed",
        );
      },
      { timeout: FIRST_LISTENING_BUDGET_MS },
    )
    .toBe(true);

  const events = await voiceEvents(page);
  const startupFailure = events.find((event) => event.event === "startup-failed");
  const started = events.find(
    (event) => event.scope === "runtime" && event.event === "wake-lock-requested",
  );
  const listening = events.find(
    (event) => event.scope === "capture" && event.event === "listening",
  );
  if (startupFailure || !started?.monotonicMs || !listening?.monotonicMs) {
    const evidence = await page.evaluate(
      (id) => ({
        state: window.__ccTest?.voice.snapshot(id),
        diagnostics: window.__devAnywhereVoicePilotDiagnostics?.snapshot() ?? [],
        notifications: Array.from(document.querySelectorAll("[data-sonner-toast]"), (element) =>
          element.textContent?.trim(),
        ).filter(Boolean),
      }),
      sessionId,
    );
    throw new Error(`Voice Pilot startup failed:\n${JSON.stringify(evidence, null, 2)}`);
  }

  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => /\/fvad(?:-[^/]+)?\.wasm(?:\?|$)/.test(entry.name))
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return {
          name: new URL(resource.name).pathname,
          durationMs: resource.duration,
          responseEndMs: resource.responseEnd,
          transferSize: resource.transferSize,
          encodedBodySize: resource.encodedBodySize,
          decodedBodySize: resource.decodedBodySize,
          initiatorType: resource.initiatorType,
        };
      }),
  );
  return {
    clickToListeningMs: listening.monotonicMs - started.monotonicMs,
    startedAtMs: started.monotonicMs,
    listeningAtMs: listening.monotonicMs,
    resources,
  };
}

function isAsrAttemptStart(event: VoiceDiagnosticEvent): boolean {
  return event.scope === "asr" && event.event === "speech-attempt-starting";
}

declare global {
  interface Window {
    __devAnywhereVoicePilotDiagnostics?: {
      snapshot(): VoiceDiagnosticEvent[];
      clear(): void;
    };
  }
}
