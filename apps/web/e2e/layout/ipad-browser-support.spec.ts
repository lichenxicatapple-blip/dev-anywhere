import { expect, test } from "@playwright/test";
import { installFakeRelay, sentFakeRelayMessages } from "../helpers";
import { expectNoHorizontalDocumentOverflow, expectTouchTarget } from "../mobile-helpers";

const IPAD_VIEWPORT = { width: 1194, height: 834 };
const IPAD_CHROME_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 26_5_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/150.0.7871.51 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 26_5_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1";

test.describe("iPad Chrome browser gate", () => {
  test.use({ viewport: IPAD_VIEWPORT, hasTouch: true, userAgent: IPAD_CHROME_USER_AGENT });

  test("requires Safari before mounting the application shell", async ({ page }) => {
    const relaySetupRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/health" || pathname === "/api/auth/client") {
        relaySetupRequests.push(pathname);
      }
    });
    await installFakeRelay(page);
    await page.goto("/#/chat/test?mode=pty");

    const gate = page.locator('[data-slot="unsupported-ipad-browser"]');
    await expect(gate).toBeVisible();
    await expect(gate.getByRole("heading", { name: "请使用 Safari 打开" })).toBeVisible();
    await expect(gate).toContainText("iPad 上的 Chrome");
    await expect(page.locator('[data-slot="app-shell"]')).toHaveCount(0);
    expect(await sentFakeRelayMessages(page)).toEqual([]);
    expect(relaySetupRequests).toEqual([]);
    const copyButton = gate.getByRole("button", { name: "复制当前链接" });
    await expectTouchTarget(copyButton);
    await copyButton.click();
    await expect(gate.getByRole("button", { name: "链接已复制" })).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
  });
});

test.describe("iPad Safari browser support", () => {
  test.use({ viewport: IPAD_VIEWPORT, hasTouch: true, userAgent: IPAD_SAFARI_USER_AGENT });

  test("mounts the normal application shell", async ({ page }) => {
    await installFakeRelay(page);
    await page.goto("/");

    await expect(page.locator('[data-slot="app-shell"]')).toBeVisible();
    await expect(page.locator('[data-slot="unsupported-ipad-browser"]')).toHaveCount(0);
  });
});
