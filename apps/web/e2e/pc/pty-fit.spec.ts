import { expect, test, type Page } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

async function readResizeRequests(page: Page) {
  return page.evaluate(() =>
    window.__ptySmoke.sent
      .map(
        (raw) => JSON.parse(raw) as { type: string; sessionId: string; cols: number; rows: number },
      )
      .filter((msg) => msg.type === "terminal_resize_request"),
  );
}

async function fit(page: Page): Promise<void> {
  await page.locator('[data-slot="chat-overflow-trigger"]').click();
  await page.getByRole("menuitem", { name: "按窗口调整终端尺寸", exact: true }).click();
  await expect(page.locator('[data-slot="chat-overflow-menu"]')).toHaveCount(0);
}

async function expectFittedViewport(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator('[data-slot="pty-terminal"]').evaluate((container) => {
        const screen = container.querySelector<HTMLElement>(".xterm-screen")!;
        return {
          screenFits: screen.getBoundingClientRect().width <= container.clientWidth,
          noHorizontalScroll: container.scrollWidth <= container.clientWidth + 1,
          documentFits: document.documentElement.scrollWidth <= window.innerWidth,
        };
      }),
    )
    .toEqual({ screenFits: true, noHorizontalScroll: true, documentFits: true });
}

test("manually fits a hosted PTY to desktop and phone without reconnecting", async ({ page }) => {
  const sessionId = "hosted-pty-manual-fit";
  await page.setViewportSize({ width: 1280, height: 900 });
  await setupPtyChat(page, {
    sessionId,
    sessionKind: "agent",
    provider: "codex",
    ptyOwner: "proxy-hosted",
    cols: 80,
    rows: 24,
  });
  await expectPtyTerminalMounted(page);
  await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
    "data-connection-ready",
    "true",
  );
  const subscriptionsBefore = await page.evaluate(
    () =>
      window.__ptySmoke.sent.filter((raw) => JSON.parse(raw).type === "session_subscribe").length,
  );
  expect(await readResizeRequests(page)).toEqual([]);
  await fit(page);
  await expect.poll(async () => (await readResizeRequests(page)).length).toBe(1);
  const desktop = (await readResizeRequests(page))[0]!;
  expect(desktop.sessionId).toBe(sessionId);
  expect(desktop.cols).toBeGreaterThan(80);
  expect(desktop.rows).toBeGreaterThan(24);
  // The renderer must wait for the worker's ordered resize event.
  expect(await page.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.cols, sessionId)).toBe(
    80,
  );
  await page.evaluate(({ cols, rows }) => window.__ptySmoke.resize(cols, rows), desktop);
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.cols, sessionId))
    .toBe(desktop.cols);
  await expectFittedViewport(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await readResizeRequests(page)).toHaveLength(1);
  await fit(page);
  await expect.poll(async () => (await readResizeRequests(page)).length).toBe(2);
  const phone = (await readResizeRequests(page))[1]!;
  expect(phone.sessionId).toBe(sessionId);
  expect(phone.cols).toBeLessThan(80);
  expect(phone.rows).toBeGreaterThan(1);
  await page.evaluate(({ cols, rows }) => window.__ptySmoke.resize(cols, rows), phone);
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.cols, sessionId))
    .toBe(phone.cols);
  await expectFittedViewport(page);
  expect(await readResizeRequests(page)).toHaveLength(2);
  await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
    "data-connection-ready",
    "true",
  );
  expect(
    await page.evaluate(
      () =>
        window.__ptySmoke.sent.filter((raw) => JSON.parse(raw).type === "session_subscribe").length,
    ),
  ).toBe(subscriptionsBefore);
});

test("does not offer remote fitting for a locally owned terminal", async ({ page }) => {
  await setupPtyChat(page, {
    sessionId: "local-pty-no-fit",
    sessionKind: "agent",
    provider: "kimi",
    ptyOwner: "local-terminal",
    cols: 113,
    rows: 29,
  });
  await expectPtyTerminalMounted(page);
  await page.locator('[data-slot="chat-overflow-trigger"]').click();
  await expect(page.getByRole("menuitem", { name: "按窗口调整终端尺寸", exact: true })).toHaveCount(
    0,
  );
  expect(await readResizeRequests(page)).toEqual([]);
});

test("fits on the first click after leaving and returning to a cached PTY", async ({ page }) => {
  const sessionId = "hosted-pty-fit-route-return";
  await page.setViewportSize({ width: 390, height: 844 });
  await setupPtyChat(page, {
    sessionId,
    sessionKind: "agent",
    provider: "codex",
    ptyOwner: "proxy-hosted",
    cols: 80,
    rows: 24,
  });
  await expectPtyTerminalMounted(page);
  await fit(page);
  await expect.poll(async () => (await readResizeRequests(page)).length).toBe(1);
  const phone = (await readResizeRequests(page))[0]!;
  await page.evaluate(({ cols, rows }) => window.__ptySmoke.resize(cols, rows), phone);
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.cols, sessionId))
    .toBe(phone.cols);

  const header = (await page.locator('[data-slot="chat-header"]').elementHandle())!;
  const terminal = (await page.locator('[data-slot="pty-terminal"]').elementHandle())!;
  const entry = page.locator(`[data-slot="pty-keepalive-entry"][data-session-id="${sessionId}"]`);
  await page.locator('[data-slot="chat-back-button"]').click();
  await expect(page).toHaveURL(/#\/sessions$/);
  expect(await header.evaluate((node) => node.isConnected)).toBe(false);
  await expect(entry).toHaveAttribute("data-active", "false");

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/chat/${sessionId}\\?mode=pty$`));
  await expect(entry).toHaveAttribute("data-active", "true");
  expect(await terminal.evaluate((node) => node.isConnected)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await readResizeRequests(page)).toHaveLength(1);

  // The page remounted, but its cached view must not confuse this click with the old request.
  await fit(page);
  await expect.poll(async () => (await readResizeRequests(page)).length).toBe(2);
  const desktop = (await readResizeRequests(page))[1]!;
  expect(desktop.sessionId).toBe(sessionId);
  expect(desktop.cols).toBeGreaterThan(phone.cols);
  expect(await page.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.cols, sessionId)).toBe(
    phone.cols,
  );
  await page.evaluate(({ cols, rows }) => window.__ptySmoke.resize(cols, rows), desktop);
  await expectFittedViewport(page);
  expect(await readResizeRequests(page)).toHaveLength(2);
});
