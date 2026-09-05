import { expect, mobileBaseUrl, test } from "../fixtures/cdp";
import { installFakeRelay } from "../helpers";
import { dispatchTouchSwipe } from "../touch-input";

test.describe("L4 mobile / offline proxy swipe action", () => {
  test.setTimeout(60_000);

  test("keeps remove covered until a real Android Chrome left swipe", async ({
    emuPage,
  }, testInfo) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/`);
    await emuPage.reload();
    await expect(emuPage.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]')).toBeVisible({
      timeout: 30_000,
    });
    await emuPage.evaluate(() => window.__devAnywhereE2E?.setProxyOnline(false));

    const row = emuPage.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]');
    const foreground = row.locator('[data-slot="proxy-swipe-foreground"]');
    const remove = row.locator('[data-slot="proxy-mobile-remove"]');
    await expect(row).toHaveAttribute("data-online", "false");
    await expect(row).not.toHaveAttribute("data-revealed", "true");
    await expect(remove).toHaveAttribute("aria-hidden", "true");
    await expect(emuPage.locator('[data-slot="proxy-row-menu-trigger"]')).toHaveCount(0);

    const closed = await foreground.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.right - 16, rect.top + rect.height / 2);
      return {
        opacity: getComputedStyle(node).opacity,
        offset: node.getAttribute("data-offset"),
        foregroundRight: rect.right,
        hitForeground: hit?.closest('[data-slot="proxy-swipe-foreground"]') === node,
        start: { x: rect.right - 16, y: rect.top + rect.height / 2 },
        end: { x: rect.right - 96, y: rect.top + rect.height / 2 + 1 },
      };
    });
    expect(closed).toMatchObject({ opacity: "1", offset: "0", hitForeground: true });
    await testInfo.attach("offline-proxy-closed", {
      body: await row.screenshot(),
      contentType: "image/png",
    });

    await dispatchTouchSwipe(emuPage, closed.start, closed.end);

    await expect(row).toHaveAttribute("data-revealed", "true");
    await expect(remove).not.toHaveAttribute("aria-hidden");
    const revealed = await row.evaluate((node) => {
      const rowRect = node.getBoundingClientRect();
      const foregroundRect = node
        .querySelector<HTMLElement>('[data-slot="proxy-swipe-foreground"]')!
        .getBoundingClientRect();
      const actionRect = node
        .querySelector<HTMLElement>('[data-slot="proxy-mobile-remove"]')!
        .getBoundingClientRect();
      const hit = document.elementFromPoint(rowRect.right - 40, rowRect.top + rowRect.height / 2);
      return {
        foregroundRight: foregroundRect.right,
        joinGap: actionRect.left - foregroundRect.right,
        topDelta: actionRect.top - foregroundRect.top,
        bottomDelta: actionRect.bottom - foregroundRect.bottom,
        hitRemove: hit?.closest('[data-slot="proxy-mobile-remove"]') !== null,
      };
    });
    expect(closed.foregroundRight - revealed.foregroundRight).toBeCloseTo(80, 0);
    expect(revealed.joinGap).toBeCloseTo(0, 1);
    expect(revealed.topDelta).toBeCloseTo(0, 1);
    expect(revealed.bottomDelta).toBeCloseTo(0, 1);
    expect(revealed.hitRemove).toBe(true);
    await testInfo.attach("offline-proxy-revealed", {
      body: await row.screenshot(),
      contentType: "image/png",
    });
  });
});
