import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay } from "../helpers";

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
  await page.locator('[data-slot="message-list"]').hover();
  await page.mouse.wheel(0, -pxFromBottom);
  await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveJSProperty(
    "inert",
    pxFromBottom <= 8,
  );
}

async function scrollToBottom(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-slot="message-list"]');
        if (!el) return 0;
        return Math.max(0, el.scrollHeight - el.clientHeight);
      }),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const el = document.querySelector('[data-slot="message-list"]');
    if (!el) return;
    (el as HTMLElement).scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-slot="message-list"]');
        if (!el) return -1;
        return el.scrollHeight - (el.scrollTop + el.clientHeight);
      }),
    )
    .toBeLessThanOrEqual(8);
}

async function startMessageOverlapRecorder(page: Page, frames: number): Promise<void> {
  await page.evaluate((frameCount) => {
    const w = window as Window & {
      __devAnywhereMessageOverlapSamples?: Array<
        Array<{ previousIndex: number; index: number; previousBottom: number; top: number }>
      >;
      __devAnywhereMessageOverlapDone?: boolean;
    };
    w.__devAnywhereMessageOverlapSamples = [];
    w.__devAnywhereMessageOverlapDone = false;

    function readOverlaps() {
      const items = Array.from(document.querySelectorAll<HTMLElement>("[data-index]"))
        .map((item) => {
          const rect = item.getBoundingClientRect();
          return {
            index: Number(item.dataset.index),
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
          };
        })
        .filter((item) => Number.isFinite(item.index) && item.height > 0)
        .sort((a, b) => a.index - b.index);

      const overlaps: Array<{
        previousIndex: number;
        index: number;
        previousBottom: number;
        top: number;
      }> = [];
      for (let i = 1; i < items.length; i++) {
        const previous = items[i - 1];
        const current = items[i];
        if (current.top < previous.bottom - 1) {
          overlaps.push({
            previousIndex: previous.index,
            index: current.index,
            previousBottom: Math.round(previous.bottom * 10) / 10,
            top: Math.round(current.top * 10) / 10,
          });
        }
      }
      return overlaps;
    }

    let sampled = 0;
    const tick = () => {
      const overlaps = readOverlaps();
      if (overlaps.length > 0) {
        w.__devAnywhereMessageOverlapSamples?.push(overlaps);
      }
      sampled += 1;
      if (sampled >= frameCount) {
        w.__devAnywhereMessageOverlapDone = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, frames);
}

async function readMessageOverlapSamples(
  page: Page,
): Promise<
  Array<Array<{ previousIndex: number; index: number; previousBottom: number; top: number }>>
> {
  await page.waitForFunction(() => {
    const w = window as Window & { __devAnywhereMessageOverlapDone?: boolean };
    return w.__devAnywhereMessageOverlapDone === true;
  });
  return page.evaluate(() => {
    const w = window as Window & {
      __devAnywhereMessageOverlapSamples?: Array<
        Array<{ previousIndex: number; index: number; previousBottom: number; top: number }>
      >;
    };
    return w.__devAnywhereMessageOverlapSamples ?? [];
  });
}

test.describe("ChatJsonView — history replay stability", () => {
  test.use({ viewport: { width: 2048, height: 1200 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/fo-sess?mode=json");
  });

  test("does not overlap live bubbles when late history is merged after refresh", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      const sid = "fo-sess";
      hooks.chat.addUserMessage(sid, {
        id: "live-before-history-user",
        role: "user",
        text: "刷新后先发出去的新消息",
        isPartial: false,
        timestamp: Date.now(),
        toolCalls: [],
      });
      hooks.chat.appendAssistantText(sid, "live assistant before late history");
      hooks.chat.markTurnComplete(sid);
    });

    await expect(page.getByText("live assistant before late history")).toBeVisible();
    await startMessageOverlapRecorder(page, 90);

    await page.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      const sid = "fo-sess";
      hooks.chat.loadHistory(sid, [
        {
          role: "user",
          text: "历史问题：用表格展示 Rust 和 Go 的区别",
          timestamp: Date.now() - 20_000,
        },
        {
          role: "assistant",
          text:
            "| 维度 | Rust | Go |\\n" +
            "|---|---|---|\\n" +
            "| 设计哲学 | 安全、性能、控制力 | 简单、高效、快速上手 |\\n" +
            "| 内存管理 | 所有权 + 借用检查器，无 GC | 垃圾回收 |\\n" +
            "| 并发模型 | async/await + Send/Sync trait | goroutine + channel |\\n\\n" +
            Array.from({ length: 24 }, (_, i) => `- 历史长回复第 ${i + 1} 行`).join("\\n"),
          timestamp: Date.now() - 19_000,
        },
      ]);
      hooks.chat.addUserMessage(sid, {
        id: "live-after-history-user",
        role: "user",
        text: "历史回放后继续发消息",
        isPartial: false,
        timestamp: Date.now() + 1,
        toolCalls: [],
      });
      hooks.chat.appendAssistantText(sid, "live assistant after late history");
      hooks.chat.markTurnComplete(sid);
    });

    await expect(page.getByText("live assistant after late history")).toBeVisible();
    const overlapSamples = await readMessageOverlapSamples(page);
    expect(overlapSamples).toEqual([]);
  });
});

test.describe("ChatJsonView — wide message layout", () => {
  test.use({ viewport: { width: 2048, height: 1200 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/fo-sess?mode=json");
  });

  test("keeps user and assistant bubbles inside one readable rail", async ({ page }) => {
    await page.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      const sid = "fo-sess";
      hooks.chat.addUserMessage(sid, {
        id: "wide-u1",
        role: "user",
        text: "用表格展示下 Rust 和 Go 的区别",
        isPartial: false,
        timestamp: Date.now(),
        toolCalls: [],
      });
      hooks.chat.addUserMessage(sid, {
        id: "wide-a1",
        role: "assistant",
        text:
          "| 维度 | Rust | Go |\\n" +
          "|---|---|---|\\n" +
          "| 设计哲学 | 安全、性能、控制力 | 简单、高效、快速上手 |\\n" +
          "| 内存管理 | 所有权 + 借用检查器，无 GC | 垃圾回收 |\\n\\n" +
          Array.from({ length: 10 }, (_, i) => `- 第 ${i + 1} 点：用于撑高气泡。`).join("\\n"),
        isPartial: false,
        timestamp: Date.now() + 1,
        toolCalls: [],
      });
      hooks.chat.addUserMessage(sid, {
        id: "wide-u2",
        role: "user",
        text: "👋",
        isPartial: false,
        timestamp: Date.now() + 2,
        toolCalls: [],
      });
    });

    await expect(page.locator('[data-slot="message-row"]')).toHaveCount(3);

    const metrics = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('[data-slot="message-list"]');
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="message-row"]'));
      const input = document.querySelector<HTMLElement>('[data-slot="input-bar"]');
      const inputRect = input?.getBoundingClientRect();
      return {
        list: list ? list.getBoundingClientRect().toJSON() : null,
        input: inputRect
          ? {
              left: inputRect.left,
              right: inputRect.right,
              width: inputRect.width,
            }
          : null,
        rows: rows.map((row) => {
          const rect = row.getBoundingClientRect();
          const bubble = row.firstElementChild as HTMLElement | null;
          const bubbleRect = bubble?.getBoundingClientRect();
          return {
            width: rect.width,
            left: rect.left,
            right: rect.right,
            bubbleLeft: bubbleRect?.left ?? null,
            bubbleRight: bubbleRect?.right ?? null,
          };
        }),
      };
    });

    expect(metrics.list).not.toBeNull();
    expect(metrics.input).not.toBeNull();
    for (const row of metrics.rows) {
      expect(row.width).toBeGreaterThan(1200);
      expect(row.width).toBeLessThanOrEqual(1450);
      expect(Math.abs(row.left - metrics.rows[0].left)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.right - metrics.rows[0].right)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(metrics.input!.left - metrics.rows[0].left)).toBeLessThanOrEqual(8);
    expect(Math.abs(metrics.input!.right - metrics.rows[0].right)).toBeLessThanOrEqual(8);
    expect(metrics.rows[0].bubbleRight).toBeCloseTo(metrics.rows[0].right, 0);
    expect(metrics.rows[1].bubbleLeft).toBeCloseTo(metrics.rows[1].left, 0);
    expect(metrics.rows[2].bubbleRight).toBeCloseTo(metrics.rows[2].right, 0);
  });

  test("keeps short assistant replies compact inside the rail", async ({ page }) => {
    await page.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      hooks.chat.addUserMessage("fo-sess", {
        id: "wide-short-a1",
        role: "assistant",
        text: "👋 喵~",
        isPartial: false,
        timestamp: Date.now(),
        toolCalls: [],
      });
    });

    await expect(page.locator('[data-slot="message-bubble"][data-role="assistant"]')).toBeVisible();

    const metrics = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[data-slot="message-row"]');
      const bubble = row?.firstElementChild as HTMLElement | null;
      const rowRect = row?.getBoundingClientRect();
      const bubbleRect = bubble?.getBoundingClientRect();
      return {
        rowWidth: rowRect?.width ?? 0,
        bubbleWidth: bubbleRect?.width ?? 0,
        bubbleLeft: bubbleRect?.left ?? 0,
        rowLeft: rowRect?.left ?? 0,
      };
    });

    expect(metrics.rowWidth).toBeGreaterThan(1200);
    expect(metrics.bubbleWidth).toBeLessThan(180);
    expect(Math.abs(metrics.bubbleLeft - metrics.rowLeft)).toBeLessThanOrEqual(1);
  });
});

test.describe("ChatJsonView — BackToBottom threshold + click + follow", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/fo-sess?mode=json");
    await seedMessages(page, 30);
    await scrollToBottom(page);
  });

  test("only appears after leaving the bottom threshold", async ({ page }) => {
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toHaveJSProperty("inert", true);
    await scrollBy(page, 5);
    await expect(btb).toHaveJSProperty("inert", true);
    await scrollBy(page, 10);
    await expect(btb).toHaveJSProperty("inert", false);
  });

  test("button position is sticky; does not scroll with content", async ({ page }) => {
    await scrollBy(page, 200);
    const btb = page.locator('[data-slot="back-to-bottom"]');
    const first = await btb.boundingBox();
    expect(first).not.toBeNull();

    // 继续向上滚动大幅距离, 按钮 viewport 坐标应不变
    await page.locator('[data-slot="message-list"]').hover();
    await page.mouse.wheel(0, -600);
    await expect(btb).toHaveJSProperty("inert", false);
    const second = await btb.boundingBox();
    expect(second).not.toBeNull();
    expect(Math.abs((first!.y ?? 0) - (second!.y ?? 0))).toBeLessThan(2);
    expect(Math.abs((first!.x ?? 0) - (second!.x ?? 0))).toBeLessThan(2);
  });

  test("button geometry stays stable when it fades out at bottom", async ({ page }) => {
    await scrollBy(page, 200);
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toHaveJSProperty("inert", false);
    const visibleBox = await btb.boundingBox();
    expect(visibleBox).not.toBeNull();

    await scrollToBottom(page);
    await expect(btb).toHaveJSProperty("inert", true);
    const hiddenBox = await btb.boundingBox();
    expect(hiddenBox).not.toBeNull();

    expect(Math.abs((visibleBox!.x ?? 0) - (hiddenBox!.x ?? 0))).toBeLessThan(1);
    expect(Math.abs((visibleBox!.y ?? 0) - (hiddenBox!.y ?? 0))).toBeLessThan(1);
    expect(Math.abs((visibleBox!.width ?? 0) - (hiddenBox!.width ?? 0))).toBeLessThan(1);
    expect(Math.abs((visibleBox!.height ?? 0) - (hiddenBox!.height ?? 0))).toBeLessThan(1);
  });

  test("click scrolls to bottom and hides button", async ({ page }) => {
    await scrollBy(page, 500);
    const btb = page.locator('[data-slot="back-to-bottom"]');
    await expect(btb).toBeVisible();
    await btb.click();
    await expect(btb).toHaveJSProperty("inert", true);
    // expect.poll 让 click → scroll-to-bottom → react re-render 跑完, 再断言 gap.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('[data-slot="message-list"]');
          if (!el) return -1;
          return el.scrollHeight - (el.scrollTop + el.clientHeight);
        }),
      )
      .toBeLessThanOrEqual(8);
  });

  test("new message while scrolled up shows has-new-messages indicator", async ({ page }) => {
    await scrollBy(page, 300);
    await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveJSProperty("inert", false);

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

    const hasNewIndicator = page.locator('[data-slot="back-to-bottom-new-indicator"]');
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

    // auto-follow 应把 scrollTop 推到底, gap 收敛到 ≤ 8.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('[data-slot="message-list"]');
          if (!el) return -1;
          return el.scrollHeight - (el.scrollTop + el.clientHeight);
        }),
      )
      .toBeLessThanOrEqual(8);
    await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveJSProperty("inert", true);
  });
});
