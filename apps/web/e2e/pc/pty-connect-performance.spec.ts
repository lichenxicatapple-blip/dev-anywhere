import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "../helpers";

const SESSION_IDS = Array.from({ length: 6 }, (_, index) => `perf-pty-${index + 1}`);

async function seedPtySessions(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.evaluate((sessionIds) => {
    const now = Date.now();
    localStorage.setItem(
      "__dev_anywhere_e2e_sessions",
      JSON.stringify(
        sessionIds.map((sessionId, index) => ({
          sessionId,
          name: `/home/dev/projects/${sessionId}`,
          cwd: `/home/dev/projects/${sessionId}`,
          state: "idle",
          mode: "pty",
          provider: index % 2 === 0 ? "codex" : "claude",
          ptyOwner: "proxy-hosted",
          lastActive: now - index * 1_000,
        })),
      ),
    );
  }, SESSION_IDS);
  await page.reload();
  await selectFakeProxy(page);
}

async function waitForTerminalCount(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__ccTestPtyTerminals?.size ?? 0)).toBe(count);
}

async function resetFrameGaps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as typeof window & { __ptyPerfFrameGaps?: number[] };
    scope.__ptyPerfFrameGaps = [];
  });
}

async function readFrameGaps(page: Page): Promise<{ max: number; samples: number }> {
  return page.evaluate(() => {
    const gaps =
      (window as typeof window & { __ptyPerfFrameGaps?: number[] }).__ptyPerfFrameGaps ?? [];
    return { max: Math.max(0, ...gaps), samples: gaps.length };
  });
}

test.describe("PTY connection performance", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps cached terminals intact without replaying unchanged snapshots", async ({ page }) => {
    await installFakeRelay(page);
    await seedPtySessions(page);

    for (const sessionId of SESSION_IDS) {
      await page.goto(`${BASE_URL}/#/chat/${sessionId}?mode=pty`);
      await expect(
        page.locator(
          `[data-slot="pty-keepalive-entry"][data-session-id="${sessionId}"] [data-slot="pty-host"] .xterm`,
        ),
      ).toBeVisible();
      await page.evaluate((id) => {
        window.__devAnywhereE2E?.socket?.emitPty(
          id,
          Array.from(
            { length: 1_500 },
            (_, index) => `${id} reconnect payload ${String(index).padStart(4, "0")}\r\n`,
          ).join(""),
        );
      }, sessionId);
      await expect
        .poll(() => page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", sessionId))
        .toContain(`${sessionId} reconnect payload 1499`);
    }

    await waitForTerminalCount(page, SESSION_IDS.length);
    await page.evaluate(() => {
      const scope = window as typeof window & {
        __ptyPerfTerminalBefore?: Map<string, unknown>;
        __ptyPerfFrameGaps?: number[];
        __ptyPerfStopFrames?: () => void;
        __ptyPerfTerminalResets?: Map<string, number>;
      };
      scope.__ptyPerfTerminalBefore = new Map(window.__ccTestPtyTerminals);
      scope.__ptyPerfTerminalResets = new Map();
      for (const [sessionId, value] of window.__ccTestPtyTerminals ?? []) {
        const terminal = value as unknown as { reset: () => void };
        const reset = terminal.reset.bind(terminal);
        scope.__ptyPerfTerminalResets.set(sessionId, 0);
        terminal.reset = () => {
          scope.__ptyPerfTerminalResets?.set(
            sessionId,
            (scope.__ptyPerfTerminalResets.get(sessionId) ?? 0) + 1,
          );
          reset();
        };
      }
      scope.__ptyPerfFrameGaps = [];
      let previous = performance.now();
      let stopped = false;
      const tick = (timestamp: number): void => {
        scope.__ptyPerfFrameGaps?.push(timestamp - previous);
        previous = timestamp;
        if (!stopped) requestAnimationFrame(tick);
      };
      scope.__ptyPerfStopFrames = () => {
        stopped = true;
      };
      requestAnimationFrame(tick);
    });

    await resetFrameGaps(page);
    const offlineStartedAt = Date.now();
    await page.evaluate(() => window.__devAnywhereE2E?.setProxyOnline(false));
    await expect(
      page.locator('[data-slot="connection-lost-panel"][data-variant="proxy"]'),
    ).toBeVisible();
    const offlineDurationMs = Date.now() - offlineStartedAt;
    const offlineFrames = await readFrameGaps(page);
    const terminalsWhileOffline = await page.evaluate(() => window.__ccTestPtyTerminals?.size ?? 0);

    const subscribeCountsBefore = new Map(SESSION_IDS.map((sessionId) => [sessionId, 1]));
    const sentBeforeReconnect = await sentFakeRelayMessages(page);
    for (const sessionId of SESSION_IDS) {
      subscribeCountsBefore.set(
        sessionId,
        sentBeforeReconnect.filter(
          (message) => message.type === "session_subscribe" && message.sessionId === sessionId,
        ).length,
      );
    }
    await resetFrameGaps(page);
    const onlineStartedAt = Date.now();
    await page.evaluate(() => window.__devAnywhereE2E?.setProxyOnline(true));
    await waitForTerminalCount(page, SESSION_IDS.length);
    await expect(
      page.locator(
        '[data-slot="pty-keepalive-entry"][data-active="true"] [data-slot="chat-pty-view"]',
      ),
    ).toHaveAttribute("data-connection-ready", "true");
    await expect
      .poll(async () => {
        const sent = await sentFakeRelayMessages(page);
        return SESSION_IDS.every(
          (sessionId) =>
            sent.filter(
              (message) => message.type === "session_subscribe" && message.sessionId === sessionId,
            ).length > (subscribeCountsBefore.get(sessionId) ?? 0),
        );
      })
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const onlineDurationMs = Date.now() - onlineStartedAt;
    const onlineFrames = await readFrameGaps(page);

    const result = await page.evaluate(() => {
      const scope = window as typeof window & {
        __ptyPerfTerminalBefore?: Map<string, unknown>;
        __ptyPerfFrameGaps?: number[];
        __ptyPerfStopFrames?: () => void;
        __ptyPerfTerminalResets?: Map<string, number>;
      };
      scope.__ptyPerfStopFrames?.();
      const current = window.__ccTestPtyTerminals ?? new Map<string, never>();
      const retained = [...current].filter(
        ([sessionId, terminal]) => scope.__ptyPerfTerminalBefore?.get(sessionId) === terminal,
      ).length;
      return {
        retained,
        resetCount: [...(scope.__ptyPerfTerminalResets?.values() ?? [])].reduce(
          (sum, count) => sum + count,
          0,
        ),
      };
    });

    expect(terminalsWhileOffline).toBe(SESSION_IDS.length);
    expect(result.retained).toBe(SESSION_IDS.length);
    expect(result.resetCount).toBe(0);

    console.log(
      `PTY reconnect sample: offline=${terminalsWhileOffline}, retained=${result.retained}/${SESSION_IDS.length}, resets=${result.resetCount}, offline=${offlineDurationMs}ms/${offlineFrames.max.toFixed(1)}ms-gap, online=${onlineDurationMs}ms/${onlineFrames.max.toFixed(1)}ms-gap/${onlineFrames.samples}-frames`,
    );
  });
});
