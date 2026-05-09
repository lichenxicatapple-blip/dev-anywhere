import { expect, test, type Page } from "@playwright/test";

const expectRelayDown = process.env.DEV_ANYWHERE_EXPECT_RELAY_DOWN === "1";

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  const hasDesktopSwitcher = await switcher.isVisible({ timeout: 1_000 }).catch(() => false);
  if (hasDesktopSwitcher) {
    await switcher.click();
  } else {
    await page.goto("/#/");
  }

  const firstProxy = page.locator('[data-slot="proxy-item"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 15_000 });
  await firstProxy.click();
}

test.describe("real local chaos UI", () => {
  test("keeps the real UI usable while relay duplicates, delays, and reorders control messages", async ({
    page,
  }) => {
    test.skip(expectRelayDown, "normal usability smoke requires relay to be available");

    await page.goto("/#/sessions");
    await selectFirstProxy(page);

    await expect(
      page.locator('[data-slot="session-row"]:visible, [data-slot="active-empty"]:visible').first(),
    ).toBeVisible({ timeout: 15_000 });

    await page.locator('button:has-text("新建会话"):visible').last().click();
    await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();

    await page.getByLabel("工作目录").focus();
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("heading", { name: "新建会话" }).click();
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toHaveCount(0);

    await page
      .getByLabel("Agent CLI")
      .getByRole("button", { name: /Claude Code/ })
      .click();

    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("heading", { name: "新建会话" })).toHaveCount(0);
    await expect(page.getByText("请求开发机列表超时")).toHaveCount(0);
    await expect(page.getByText("连接开发机超时")).toHaveCount(0);
    await expect(page.getByText("Relay 客户端未就绪")).toHaveCount(0);
  });

  test("shows an understandable unavailable state when the real relay is down", async ({
    page,
  }) => {
    test.skip(!expectRelayDown, "relay-down smoke is driven by scripts/dev-chaos.sh");

    await page.goto("/#/sessions");

    await expect(
      page.getByText(
        /在开发机上启动 DEV Anywhere|暂无可连接开发机|请先连接开发机|选择要连接的开发机/,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-slot="session-row"]').first()).toHaveCount(0);
  });
});
