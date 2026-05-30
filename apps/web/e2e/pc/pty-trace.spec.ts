// PTY scroll trace 诊断开关 e2e: 设置持久化 / 设置页开关两条路径都能录到 container-scroll.
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pty-trace";

test.describe("PTY scroll trace diagnostics", () => {
  test("enables PTY scroll trace from settings without reloading the chat", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);
    await expect(page.locator('[data-slot="pty-scroll-trace-copy"]')).toHaveCount(0);

    await page.locator('[data-slot="sidebar-settings-trigger"]').click();
    await page.getByRole("switch", { name: "PTY 滚动追踪" }).click();
    await page.getByRole("button", { name: "Close" }).click();

    await expect(page.locator('[data-slot="pty-scroll-trace-copy"]')).toBeVisible();

    await page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 120);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const trace = window.__devAnywherePtyScrollTrace ?? [];
          return trace.some((entry) => entry.event === "container-scroll");
        }),
      )
      .toBeTruthy();
  });
});
