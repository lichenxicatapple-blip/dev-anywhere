import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay, resetLocalState } from "../helpers";

test.describe("L4 mobile / session history loading", () => {
  test.setTimeout(60_000);

  test("shows a pending placeholder without blocking active sessions", async ({ emuPage }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/`);
    await emuPage.reload();
    await resetLocalState(emuPage);

    const proxy = emuPage
      .locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]:visible')
      .last();
    await expect(proxy).toBeVisible({ timeout: 30_000 });
    await emuPage.evaluate(() => window.__devAnywhereE2E?.setSessionHistoryDelay(1_500));
    await proxy.click();

    await expect(emuPage).toHaveURL(/#\/sessions/, { timeout: 15_000 });
    await expect(emuPage.locator('[data-slot="session-row"]:visible').first()).toBeVisible();
    await expect(emuPage.locator('[data-slot="history-loading"]:visible')).toContainText(
      "正在加载会话记录",
    );
    await expect(emuPage.locator('[data-slot="history-empty"]:visible')).toHaveCount(0);

    const refresh = emuPage.locator('[data-slot="history-refresh"]:visible');
    await refresh.scrollIntoViewIfNeeded();
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    const tapTarget = await refresh.boundingBox();
    expect(tapTarget?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(tapTarget?.height ?? 0).toBeGreaterThanOrEqual(44);

    await expect(emuPage.locator('[data-slot="history-loading"]:visible')).toHaveCount(0, {
      timeout: 8_000,
    });
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(emuPage.locator('[data-slot="history-section-header"]:visible')).toContainText(
      "· 2",
    );
  });
});
