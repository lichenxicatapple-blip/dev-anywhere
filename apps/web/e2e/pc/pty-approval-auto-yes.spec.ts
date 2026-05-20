import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pc-pty-approval-auto-yes";

test.describe("PTY approval auto yes", () => {
  test("banner exposes Always yes and sends one Enter per approval window", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    await page.evaluate(() => window.__ptySmoke.setPtyState("approval_wait"));

    const hint = page.locator('[data-slot="pty-approval-hint"]');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveClass(/dev-status-line-waiting_approval/);
    await expect(hint.locator(".dev-status-line-sweep-waiting")).toBeVisible();

    await hint.getByRole("button", { name: "Always yes" }).click();
    await expect.poll(() => readRawPtyInput(page)).toBe("\r");

    await page.evaluate(() => window.__ptySmoke.setPtyState("approval_wait"));
    await page.waitForTimeout(100);
    await expect.poll(() => readRawPtyInput(page)).toBe("\r");

    await page.evaluate(() => window.__ptySmoke.setPtyState("working"));
    await page.evaluate(() => window.__ptySmoke.setPtyState("approval_wait"));
    await expect.poll(() => readRawPtyInput(page)).toBe("\r\r");
  });
});
