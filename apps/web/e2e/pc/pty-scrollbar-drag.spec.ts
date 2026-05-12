// PTY 垂直滚动条 thumb 拖拽真改变 scrollTop. 现有 pty-scroll spec 只验 scrollbar 出现
// + opacity + 位置布局, 没真验拖拽行为.
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pty-scrollbar-drag";

test.describe("PTY scrollbar thumb drag", () => {
  test("dragging vertical scrollbar thumb scrolls the terminal", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    // 灌长 buffer 让 thumb 短(可拖动距离大).
    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 200 }, (_, i) => `vline ${String(i).padStart(3, "0")}\r\n`).join(""),
      );
    });

    const terminal = page.locator('[data-slot="pty-terminal"]');
    const scrollbar = page.locator('[data-slot="pty-scrollbar"]');
    const thumb = page.locator('[data-slot="pty-scrollbar-thumb"]');

    // hover 让 scrollbar 浮起 (scrolling || hovering || dragging 任一即可见).
    await terminal.hover();
    await expect(scrollbar).toBeVisible();
    await expect(thumb).toBeVisible();

    const initialScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);
    expect(initialScrollTop).toBeGreaterThan(0); // 灌完默认在底部, 自然 > 0.

    // 拖 thumb 到 scrollbar 顶端.
    const thumbBox = await thumb.boundingBox();
    const scrollbarBox = await scrollbar.boundingBox();
    if (!thumbBox || !scrollbarBox) throw new Error("scrollbar / thumb 没 boundingBox");

    await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(scrollbarBox.x + scrollbarBox.width / 2, scrollbarBox.y + 5, {
      steps: 8,
    });
    await page.mouse.up();

    // 拖到顶: scrollTop 应回退到接近 0.
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeLessThan(initialScrollTop / 2);
  });
});
