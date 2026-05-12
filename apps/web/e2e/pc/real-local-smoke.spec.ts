import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectNoHorizontalDocumentOverflow, expectTouchTarget } from "../mobile-helpers";

const enabled = process.env.DEV_ANYWHERE_REAL_LOCAL_SMOKE === "1";
const createRealSessions = process.env.DEV_ANYWHERE_REAL_CREATE_SESSION_SMOKE === "1";
const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:5173";
const localBaseUrl = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(baseUrl);
const smokeCwd = process.env.DEV_ANYWHERE_REAL_PROVIDER_CWD ?? process.cwd();
const modelSmokeToken = "MOBILE_SMOKE_MODEL_OK";

test.describe("real local smoke", () => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_LOCAL_SMOKE=1 to touch local relay/proxy");
  test.skip(!localBaseUrl, "real local smoke only accepts localhost WEB_BASE_URL values");

  test("lists the real proxy and opens create-session resources", async ({ page }) => {
    await page.goto("/#/sessions");
    await selectFirstProxy(page);
    await expectSessionListReady(page);
    await expectNoHorizontalDocumentOverflow(page);

    await expectMobileSettingsDialog(page);

    const create = page.locator('button:has-text("新建会话"):visible').last();
    await expect(create).toBeVisible({ timeout: 15_000 });
    if (isMobile(page)) await expectTouchTarget(create);
    await create.click();

    const heading = page.getByRole("heading", { name: "新建会话" });
    await expect(heading).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalDocumentOverflow(page);

    const workdir = page.getByLabel("工作目录");
    await expect(workdir).toBeVisible();
    if (isMobile(page)) await expectTouchTarget(workdir);
    await workdir.focus();
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toBeVisible({
      timeout: 15_000,
    });

    await expect(
      page
        .getByLabel("Agent CLI")
        .getByRole("button", { name: /Claude Code|Codex/ })
        .first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(heading).toHaveCount(0);
  });

  test("opens an existing real session read-only", async ({ page }) => {
    await page.goto("/#/sessions");
    await selectFirstProxy(page);
    const row = page.locator('[data-slot="session-row"]:visible').first();
    test.skip((await row.count()) === 0, "no existing real session to open read-only");

    await row.locator("button").first().click();
    await expect(page).toHaveURL(/\/chat\/[^?]+/, { timeout: 15_000 });
    await expect(
      page
        .locator('[data-slot="chat-pty-view"], [data-slot="input-bar-region"]')
        .or(page.locator('[data-slot="terminated-session-panel"]'))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("creates and terminates a real hosted PTY from mobile", async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(
      !createRealSessions,
      "set DEV_ANYWHERE_REAL_CREATE_SESSION_SMOKE=1 to create a real PTY",
    );

    let sessionId: string | undefined;
    await page.goto("/#/sessions");
    await selectFirstProxy(page);
    try {
      await page.locator('button:has-text("新建会话"):visible').last().click();
      await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible({
        timeout: 15_000,
      });

      await page.getByLabel("工作目录").fill(smokeCwd);
      await page.getByRole("heading", { name: "新建会话" }).click();
      await page
        .getByLabel("交互方式")
        .getByRole("button", { name: /终端模式/ })
        .click();
      await page.getByRole("button", { name: "创建" }).last().click();

      await expect(page).toHaveURL(/\/chat\/[^?]+\?mode=pty/, { timeout: 30_000 });
      sessionId = new URL(page.url()).hash.match(/\/chat\/([^?]+)/)?.[1];
      expect(sessionId).toBeTruthy();
      await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible({ timeout: 20_000 });
      await expectNoHorizontalDocumentOverflow(page);
    } finally {
      if (sessionId) await terminateSession(page, sessionId).catch(() => undefined);
    }
  });

  test("sends a real mobile chat prompt and receives a model reply", async ({ page, browser }) => {
    test.setTimeout(240_000);
    test.skip(
      !createRealSessions,
      "set DEV_ANYWHERE_REAL_CREATE_SESSION_SMOKE=1 to create a real chat",
    );

    let sessionId: string | undefined;
    let peerContext: BrowserContext | undefined;
    await page.goto("/#/sessions");
    await selectFirstProxy(page);
    try {
      await page.locator('button:has-text("新建会话"):visible').last().click();
      await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible({
        timeout: 15_000,
      });

      await page.getByLabel("工作目录").fill(smokeCwd);
      await page.getByRole("heading", { name: "新建会话" }).click();
      await page
        .getByLabel("交互方式")
        .getByRole("button", { name: /聊天模式/ })
        .click();
      await page.getByRole("button", { name: "创建" }).last().click();

      await expect(page).toHaveURL(/\/chat\/[^?]+\?mode=json/, { timeout: 30_000 });
      sessionId = new URL(page.url()).hash.match(/\/chat\/([^?]+)/)?.[1];
      expect(sessionId).toBeTruthy();
      await expect(page.locator('[data-slot="input-bar-region"]')).toBeVisible({
        timeout: 20_000,
      });
      await expectNoHorizontalDocumentOverflow(page);

      peerContext = await browser.newContext({
        baseURL: baseUrl,
        viewport: page.viewportSize() ?? { width: 390, height: 844 },
        isMobile: isMobile(page),
        hasTouch: true,
      });
      const peerPage = await peerContext.newPage();
      await peerPage.goto("/#/sessions");
      await selectFirstProxy(peerPage);
      await peerPage.goto(`${baseUrl}/#/chat/${sessionId}?mode=json`);
      await expect(peerPage.locator('[data-slot="input-bar-region"]')).toBeVisible({
        timeout: 20_000,
      });

      const input = page.getByLabel("输入聊天消息");
      const promptText = `Reply exactly with ${modelSmokeToken}. Do not use tools.`;
      await expectTouchTarget(input);
      await input.fill(promptText);
      const send = page.locator('[data-slot="send-button"][data-variant="send"]');
      await expectTouchTarget(send);
      await send.click();

      await expect(peerPage.getByText(promptText)).toBeVisible({ timeout: 15_000 });

      await expect
        .poll(async () => page.getByText(modelSmokeToken).count(), { timeout: 180_000 })
        .toBeGreaterThanOrEqual(2);

      // Reload clears the in-memory chat store. Seeing the prompt and reply again proves the
      // real proxy history path (session_messages_request -> readSessionMessages -> UI) works.
      await page.waitForTimeout(1500);
      await page.reload();
      await expect(page.locator('[data-slot="input-bar-region"]')).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(promptText)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(modelSmokeToken).first()).toBeVisible({ timeout: 30_000 });
      await expectNoHorizontalDocumentOverflow(page);
    } finally {
      await peerContext?.close().catch(() => undefined);
      if (sessionId) await terminateSession(page, sessionId).catch(() => undefined);
    }
  });
});

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  if (await switcher.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await switcher.click();
  } else {
    await page.goto("/#/");
  }

  const firstProxy = page.locator('[data-slot="proxy-item"][data-online="true"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 30_000 });
  if (isMobile(page)) await expectTouchTarget(firstProxy);
  await firstProxy.click();
}

async function expectMobileSettingsDialog(page: Page): Promise<void> {
  if (!isMobile(page)) return;

  const settings = page.locator('[data-slot="mobile-settings-trigger"]');
  await expect(settings).toBeVisible();
  await expectTouchTarget(settings);
  await settings.click();
  await expect(page.locator('[data-slot="settings-dialog"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
}

async function expectSessionListReady(page: Page): Promise<void> {
  await expect(
    page.locator('[data-slot="session-row"]:visible, [data-slot="active-empty"]:visible').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("请求开发机列表超时")).toHaveCount(0);
  await expect(page.getByText("连接开发机超时")).toHaveCount(0);
  await expect(page.getByText("Relay 客户端未就绪")).toHaveCount(0);
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1024) < 768;
}

async function terminateSession(page: Page, sessionId: string): Promise<void> {
  await page.goto("/#/sessions");
  await selectFirstProxy(page);

  const row = page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[data-slot="session-row-menu-trigger"]').click();
  await page.locator('[data-slot="session-row-terminate-item"]').click();
  await page.locator('[data-slot="session-termination-confirm"]').click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
}
