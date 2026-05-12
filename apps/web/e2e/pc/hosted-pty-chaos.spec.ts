import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.DEV_ANYWHERE_HOSTED_PTY_CHAOS === "1";
const chaosCwd =
  process.env.DEV_ANYWHERE_HOSTED_PTY_CHAOS_CWD ?? "/tmp/dev-anywhere-chaos/hosted-pty";
const provider =
  process.env.DEV_ANYWHERE_HOSTED_PTY_CHAOS_PROVIDER === "codex" ? "codex" : "claude";

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();

  const firstProxy = page.locator('[data-slot="proxy-item"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 15_000 });
  await firstProxy.click();
}

async function terminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", sessionId);
}

test.describe("hosted PTY real chaos", () => {
  test(`removes a hosted ${provider} PTY session when the provider process exits under an attached Web UI`, async ({
    page,
  }) => {
    test.skip(!enabled, "driven by scripts/dev-chaos.sh with a controlled provider binary");

    await page.goto("/#/sessions");
    await selectFirstProxy(page);

    await page.locator('button:has-text("新建会话"):visible').last().click();
    await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
    await page.getByLabel("工作目录").fill(chaosCwd);
    if (provider === "codex") {
      await page.getByRole("button", { name: /Codex/ }).click();
    }
    await page
      .getByRole("dialog", { name: "新建会话" })
      .getByRole("button", { name: "创建" })
      .click();

    await expect(page).toHaveURL(/\/chat\/[^?]+\?mode=pty/, { timeout: 15_000 });
    const sessionId = new URL(page.url()).hash.match(/\/chat\/([^?]+)/)?.[1];
    expect(sessionId).toBeTruthy();
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await expect
      .poll(() => terminalText(page, sessionId!), { timeout: 15_000 })
      .toContain("type exit-chaos to terminate");

    const terminalInput = page.locator(
      '[data-slot="pty-host"] textarea[aria-label="Terminal input"]',
    );
    await page.locator('[data-slot="pty-terminal"]').click();
    await expect(terminalInput).toBeFocused();
    await page.keyboard.type("exit-chaos", { delay: 10 });
    await page.keyboard.press("Enter");

    await expect(page.locator('[data-slot="terminated-session-panel"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(terminalInput).toHaveCount(0);

    await page.goto("/#/sessions");
    await expect(
      page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]`),
    ).toHaveCount(0);
  });
});
