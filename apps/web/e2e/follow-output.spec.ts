import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

// 向 chat-store 注入 N 条消息, 使消息列表能触发滚动
// 依赖 main.tsx 在 dev build 装的 window.__ccTest 钩子, 无需动态 import 源码
async function seedMessages(page: Page, count: number): Promise<void> {
  await page.evaluate((n: number) => {
    const hooks = window.__ccTest;
    if (!hooks) throw new Error("window.__ccTest 未安装, 检查 dev build 是否启用 installTestHooks");
    const sid = "fo-sess";
    for (let i = 0; i < n; i++) {
      hooks.chat.addUserMessage(sid, {
        id: `u-${i}`,
        role: "user",
        text: `User message ${i}`,
        isPartial: false,
        timestamp: Date.now() + i,
        toolCalls: [],
      });
      hooks.chat.appendAssistantText(sid, `\nAsst ${i}\n`);
      hooks.chat.markTurnComplete(sid);
    }
  }, count);
}

async function scrollBy(page: Page, pxFromBottom: number): Promise<void> {
  await page.evaluate((amount: number) => {
    const el = document.querySelector('[data-slot="message-list"]');
    if (!el) return;
    (el as HTMLElement).scrollTop = el.scrollHeight - (el as HTMLElement).clientHeight - amount;
    el.dispatchEvent(new Event("scroll"));
  }, pxFromBottom);
  await page.waitForTimeout(200);
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-slot="message-list"]');
    if (!el) return;
    (el as HTMLElement).scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(200);
}

test.describe("ChatJsonView — follow-output baseline", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/fo-sess?mode=json`);
    await resetLocalState(page);
    await page.goto(`${BASE_URL}/#/chat/fo-sess?mode=json`);
  });

  test("BackToBottom absent on empty state", async ({ page }) => {
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toHaveCount(0);
  });

  test("input-bar-region present (InputBar + SemanticActionPanel wired)", async ({ page }) => {
    const region = page.locator('[data-slot="input-bar-region"]');
    await expect(region).toBeVisible();
  });
});

test.describe("ChatJsonView — BackToBottom threshold + click + follow", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/fo-sess?mode=json`);
    await resetLocalState(page);
    await page.goto(`${BASE_URL}/#/chat/fo-sess?mode=json`);
    await seedMessages(page, 30);
    await scrollToBottom(page);
  });

  test("hidden at bottom", async ({ page }) => {
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toHaveCount(0);
  });

  test("within 8px threshold keeps button hidden", async ({ page }) => {
    await scrollBy(page, 5);
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toHaveCount(0);
  });

  test("crossing threshold (10px) reveals button", async ({ page }) => {
    await scrollBy(page, 10);
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toBeVisible();
  });

  test("button position is sticky; does not scroll with content", async ({ page }) => {
    await scrollBy(page, 200);
    const btb = page.locator('[data-slot="back-to-bottom"]');
    const first = await btb.boundingBox();
    expect(first).not.toBeNull();

    // 继续向上滚动大幅距离, 按钮 viewport 坐标应不变
    await page.evaluate(() => {
      const el = document.querySelector('[data-slot="message-list"]');
      if (el) {
        (el as HTMLElement).scrollTop = 100;
        el.dispatchEvent(new Event("scroll"));
      }
    });
    await page.waitForTimeout(200);
    const second = await btb.boundingBox();
    expect(second).not.toBeNull();
    expect(Math.abs((first!.y ?? 0) - (second!.y ?? 0))).toBeLessThan(2);
    expect(Math.abs((first!.x ?? 0) - (second!.x ?? 0))).toBeLessThan(2);
  });

  test("click scrolls to bottom and hides button", async ({ page }) => {
    await scrollBy(page, 500);
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toBeVisible();
    await btb.click();
    await page.waitForTimeout(500);
    await expect(btb).toHaveCount(0);
    const gap = await page.evaluate(() => {
      const el = document.querySelector('[data-slot="message-list"]') as HTMLElement | null;
      if (!el) return null;
      return el.scrollHeight - (el.scrollTop + el.clientHeight);
    });
    expect(gap).not.toBeNull();
    expect(gap!).toBeLessThanOrEqual(8);
  });

  test("new message while scrolled up shows has-new-messages indicator", async ({ page }) => {
    await scrollBy(page, 300);
    await expect(page.locator('[data-slot="back-to-bottom"]')).toBeVisible();

    // 追加新消息, 不 auto-follow (因为 isAtBottom=false)
    await page.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      hooks.chat.addUserMessage("fo-sess", {
        id: "new-while-away",
        role: "user",
        text: "new message arrived",
        isPartial: false,
        timestamp: Date.now(),
        toolCalls: [],
      });
    });
    await page.waitForTimeout(300);

    const hasNewIndicator = page.locator('[aria-label="有新消息"]');
    await expect(hasNewIndicator).toBeVisible();
  });

  test("at-bottom new message auto-follows (isAtBottom sticky)", async ({ page }) => {
    await scrollToBottom(page);

    await page.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      hooks.chat.appendAssistantText("fo-sess", "\ntail streamed text\n");
      hooks.chat.markTurnComplete("fo-sess");
    });
    await page.waitForTimeout(300);

    const gap = await page.evaluate(() => {
      const el = document.querySelector('[data-slot="message-list"]') as HTMLElement | null;
      if (!el) return null;
      return el.scrollHeight - (el.scrollTop + el.clientHeight);
    });
    expect(gap).not.toBeNull();
    expect(gap!).toBeLessThanOrEqual(8);
    await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveCount(0);
  });
});
