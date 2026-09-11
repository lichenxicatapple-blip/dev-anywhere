import { expect, test, type Page } from "@playwright/test";
import { BASE_URL } from "../helpers";
import { spawnSessionViaRelay, type SessionViaRelay } from "../fixtures/relay-control";

const enabled = process.env.DEV_ANYWHERE_REAL_PTY_RESIZE === "1";
const relayUrl = process.env.DEV_ANYWHERE_REAL_RELAY_URL ?? "ws://127.0.0.1:3100";

async function openSession(page: Page, session: SessionViaRelay) {
  await page.goto(`${BASE_URL}/#/`);
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.locator('[data-slot="proxy-switcher-trigger"]').click();
  }
  await page
    .locator(`[data-slot="proxy-item"][data-proxy-id="${session.proxyId}"]:visible`)
    .last()
    .click();
  await expect(
    page.locator(`[data-slot="session-row"][data-session-id="${session.sessionId}"]:visible`),
  ).toBeVisible();
  await page.goto(`${BASE_URL}/#/chat/${session.sessionId}?mode=pty`);
  await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
    "data-connection-ready",
    "true",
  );
}

async function dimensions(page: Page, sessionId: string) {
  return page.evaluate((id) => {
    const term = window.__ccTestPtyTerminals?.get(id);
    return term ? { cols: term.cols, rows: term.rows } : null;
  }, sessionId);
}

test("resizes a real hosted shell and synchronizes desktop and touch viewers", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_PTY_RESIZE=1 to use a local Relay and Proxy");
  test.skip(
    !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(relayUrl),
    "requires a local Relay",
  );
  test.setTimeout(60_000);
  const session = await spawnSessionViaRelay(
    { relayUrl },
    { kind: "terminal", mode: "pty", cols: 80, rows: 24 },
  );
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  const observedSizes: Array<{ phase: string; cols: number; rows: number }> = [];

  async function verifyShell(phase: string, expected: { cols: number; rows: number }) {
    await expect.poll(() => dimensions(page, session.sessionId)).toEqual(expected);
    await expect.poll(() => dimensions(phone, session.sessionId)).toEqual(expected);
    for (const viewer of [page, phone]) {
      if (await viewer.locator('[data-slot="chat-overflow-menu"]').isVisible()) {
        await expect(viewer.locator('[data-slot="chat-menu-cols-value"]')).toHaveText(
          String(expected.cols),
        );
        await expect(viewer.locator('[data-slot="chat-menu-rows-value"]')).toHaveText(
          String(expected.rows),
        );
      }
    }
    const marker = `DA_SIZE_${phase}_${Date.now().toString(36)}`;
    session.send({
      type: "remote_input_raw",
      sessionId: session.sessionId,
      data: `stty -echo; printf '\\n${marker} '; stty size\r`,
    });
    const pattern = new RegExp(`${marker}\\s+${expected.rows}\\s+${expected.cols}`);
    await expect
      .poll(() =>
        page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", session.sessionId),
      )
      .toMatch(pattern);
    observedSizes.push({ phase, ...expected });
  }

  try {
    await openSession(page, session);
    await openSession(phone, session);
    await verifyShell("initial", { cols: 80, rows: 24 });

    await phone.locator('[data-slot="chat-overflow-trigger"]').tap();
    await expect(phone.getByText("终端尺寸", { exact: true })).toBeVisible();
    await phone.getByRole("button", { name: "增加列", exact: true }).tap();
    await phone.getByRole("button", { name: "增加列", exact: true }).tap();
    await phone.getByRole("button", { name: "增加行", exact: true }).tap();
    await verifyShell("phone_increase", { cols: 82, rows: 25 });
    await phone.screenshot({
      path: testInfo.outputPath("terminal-size-phone.png"),
      animations: "disabled",
    });

    await phone.getByRole("button", { name: "减少列", exact: true }).tap();
    await phone.getByRole("button", { name: "减少行", exact: true }).tap();
    await phone.getByRole("button", { name: "减少行", exact: true }).tap();
    await verifyShell("phone_decrease", { cols: 81, rows: 23 });
    await phone.setViewportSize({ width: 320, height: 844 });
    const menu = phone.locator('[data-slot="chat-overflow-menu"]');
    await expect(menu).toBeVisible();
    await expect
      .poll(async () => {
        const bounds = await menu.boundingBox();
        return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 320;
      })
      .toBe(true);
    await phone.screenshot({
      path: testInfo.outputPath("terminal-size-phone-320.png"),
      animations: "disabled",
    });
    await phone.setViewportSize({ width: 390, height: 844 });

    await phone.getByRole("menuitem", { name: "按窗口调整终端尺寸", exact: true }).tap();
    await expect(phone.locator('[data-slot="chat-overflow-menu"]')).toHaveCount(0);
    await expect
      .poll(async () => (await dimensions(phone, session.sessionId))?.cols ?? 999)
      .toBeLessThan(80);
    const fitted = (await dimensions(phone, session.sessionId))!;
    await verifyShell("fit", fitted);

    await phone.locator('[data-slot="chat-overflow-trigger"]').tap();
    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.getByRole("button", { name: "增加行", exact: true }).click();
    await verifyShell("desktop_increase", { cols: fitted.cols, rows: fitted.rows + 1 });
    await page.getByRole("button", { name: "减少行", exact: true }).click();
    await page.getByRole("button", { name: "减少列", exact: true }).click();
    await verifyShell("desktop_decrease", { cols: fitted.cols - 1, rows: fitted.rows });
    await testInfo.attach("real-shell-sizes", {
      body: JSON.stringify(observedSizes, null, 2),
      contentType: "application/json",
    });
  } finally {
    await mobile.close();
    await session.terminate();
  }
});
