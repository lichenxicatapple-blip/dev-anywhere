// PTY 滚动 e2e: back-to-bottom, 新消息提示, approval-wait 视图保持, resize 重新订阅,
// 触摸滚动期间不抢回底部.
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "./pty-fixture";

const SESSION_ID = "pty-scroll";

test.describe("PTY scroll: back-to-bottom, new-message hint, approval, resize, touch", () => {
  test("scrolls history, surfaces back-to-bottom, and re-subscribes after resize", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID, withVisualViewportMock: true });
    await expectPtyTerminalMounted(page);
    const touchEditingSurface = await page.evaluate(
      () => window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );

    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 90 }, (_, i) => `line ${String(i).padStart(2, "0")}\r\n`).join(""),
      );
    });
    await expect(page.locator('[data-slot="pty-scrollbar"]')).toHaveClass(/opacity-100/);

    await page.locator('[data-slot="pty-terminal"]').hover();
    await page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1200 }));
      (el as HTMLElement).scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator('[data-slot="back-to-bottom"]')).toBeVisible();

    const backToBottomScrollbarGap = async () => {
      const button = await page.locator('[data-slot="back-to-bottom"]').boundingBox();
      const scrollbar = await page.locator('[data-slot="pty-scrollbar"]').boundingBox();
      if (!button || !scrollbar) return -1;
      return Math.round(scrollbar.x - (button.x + button.width));
    };
    const backToBottomViewportGap = async () => {
      const button = await page.locator('[data-slot="back-to-bottom"]').boundingBox();
      const viewport = page.viewportSize();
      if (!button || !viewport) return -1;
      return Math.round(viewport.width - (button.x + button.width));
    };
    if (touchEditingSurface) {
      await expect.poll(backToBottomViewportGap).toBeGreaterThanOrEqual(20);
      await expect.poll(backToBottomViewportGap).toBeLessThanOrEqual(32);
    } else {
      await expect.poll(backToBottomScrollbarGap).toBeGreaterThanOrEqual(12);
      await expect.poll(backToBottomScrollbarGap).toBeLessThanOrEqual(20);
    }

    const scrollTopBeforeNewFrame = await page
      .locator('[data-slot="pty-terminal"]')
      .evaluate((el) => (el as HTMLElement).scrollTop);

    await page.evaluate(() => {
      window.__ptySmoke.sendPty("new output while reviewing history\r\n");
    });
    await expect(page.locator('[aria-label="有新消息"]')).toBeVisible();
    const scrollTopAfterNewFrame = await page
      .locator('[data-slot="pty-terminal"]')
      .evaluate((el) => (el as HTMLElement).scrollTop);
    expect(scrollTopAfterNewFrame).toBeLessThanOrEqual(scrollTopBeforeNewFrame + 8);

    await page.locator('[data-slot="back-to-bottom"]').click();
    await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect
      .poll(async () =>
        page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
          const node = el as HTMLElement;
          return node.scrollTop + node.clientHeight >= node.scrollHeight - 8;
        }),
      )
      .toBeTruthy();

    const beforeApprovalChrome = await page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
      const node = el as HTMLElement;
      return {
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
    });
    await page.evaluate(() => window.__ptySmoke.setPtyState("approval_wait"));
    await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible();
    const afterApprovalChrome = await page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
      const node = el as HTMLElement;
      return {
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
    });
    expect(afterApprovalChrome.clientHeight).toBe(beforeApprovalChrome.clientHeight);
    expect(afterApprovalChrome.scrollTop).toBeGreaterThan(0);
    expect(afterApprovalChrome.scrollTop).toBeGreaterThanOrEqual(
      beforeApprovalChrome.scrollTop - 8,
    );

    await page.evaluate(() => window.__ptySmoke.resize(100, 30));
    await expectPtyTerminalMounted(page);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            window.__ptySmoke.sent.filter((raw) => {
              try {
                return (JSON.parse(raw) as { type?: string }).type === "session_subscribe";
              } catch {
                return false;
              }
            }).length,
        ),
      )
      .toBeGreaterThanOrEqual(2);
  });

  test("does not pin users to bottom when PTY output arrives during native touch scroll", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 140 }, (_, i) => `stream line ${String(i).padStart(3, "0")}\r\n`).join(
          "",
        ),
      );
    });
    const terminal = page.locator('[data-slot="pty-terminal"]');
    await expect
      .poll(() =>
        terminal.evaluate((el) => {
          const node = el as HTMLElement;
          return node.scrollHeight - node.clientHeight;
        }),
      )
      .toBeGreaterThan(0);

    await page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]').focus();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .toBe("Terminal input");

    await terminal.evaluate((el) => {
      const touchstart = new Event("touchstart", { bubbles: true }) as TouchEvent;
      Object.defineProperty(touchstart, "touches", { value: [{ clientY: 520 }] });
      el.dispatchEvent(touchstart);
    });
    await page.evaluate(() => {
      window.__ptySmoke.sendPty("frame-before-native-scroll\r\n");
    });
    await terminal.evaluate((el) => {
      const touchmove = new Event("touchmove", { bubbles: true }) as TouchEvent;
      Object.defineProperty(touchmove, "touches", { value: [{ clientY: 460 }] });
      el.dispatchEvent(touchmove);
      const node = el as HTMLElement;
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.max(0, maxScrollTop - 600);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .not.toBe("Terminal input");
    const scrollTopBeforeNewFrame = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);

    await page.evaluate(() => {
      window.__ptySmoke.sendPty("frame-after-native-scroll\r\n");
    });

    await expect(page.locator('[aria-label="有新消息"]')).toBeVisible();
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeLessThanOrEqual(scrollTopBeforeNewFrame + 8);
  });
});
