// ptyScrollTrace 诊断开关 e2e: ?ptyScrollTrace=1 启动 / hash 变化后启用,
// 两条路径都能录到 container-scroll.
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pty-trace";

test.describe("PTY scroll trace diagnostics", () => {
  test("collects PTY scroll trace when diagnostics are enabled at navigation", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID, query: "&ptyScrollTrace=1" });
    await expectPtyTerminalMounted(page);
    await expect(page.locator('[data-slot="pty-scroll-trace-copy"]')).toBeVisible();

    const terminal = page.locator('[data-slot="pty-terminal"]');
    await terminal.evaluate((el) => {
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

  test("enables PTY scroll trace after hash query changes", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);
    await expect(page.locator('[data-slot="pty-scroll-trace-copy"]')).toHaveCount(0);

    await page.evaluate(() => {
      window.location.hash = `${window.location.hash}&ptyScrollTrace=1`;
    });

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
