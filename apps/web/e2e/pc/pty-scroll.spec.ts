// PTY 滚动 e2e: back-to-bottom, 新消息提示, approval-wait 视图保持, resize 重新订阅,
// 触摸滚动期间不抢回底部.
import { expect, test, type Page } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import {
  backToBottom,
  backToBottomNewIndicator,
  enterLongHostMode,
  expectBackToBottomClearance,
  expectPtyAtBottom,
  expectPtyScrollable,
  expectPtySessionSubscribeCount,
  ptyApprovalHint,
  ptyInput,
  ptyScrollbar,
  ptyTerminal,
  readPtyScrollMetrics,
  resizePty,
  scrollPtyToTop,
  sendPtyLines,
  sendPtyOutput,
  setPtyState,
} from "../pty-scroll-helpers";

const SESSION_ID = "pty-scroll";

async function waitForAnimationFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () => {
          frames += 1;
          if (frames >= frameCount) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );
}

test.describe("PTY scroll: back-to-bottom, new-message hint, approval, resize, touch", () => {
  test("scrolls history, surfaces back-to-bottom, and re-subscribes after resize", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID, withVisualViewportMock: true });
    await expectPtyTerminalMounted(page);
    const touchEditingSurface = await page.evaluate(
      () => window.matchMedia("(pointer: coarse), (hover: none)").matches,
    );

    await sendPtyLines(page, { count: 90, pad: 2 });
    await expect(ptyScrollbar(page)).toHaveClass(/opacity-100/);

    await ptyTerminal(page).hover();
    await scrollPtyToTop(page, { wheelDeltaY: -1200 });
    await expect(backToBottom(page)).toBeVisible();
    await expectBackToBottomClearance(page, { touchEditingSurface });

    const scrollTopBeforeNewFrame = (await readPtyScrollMetrics(page)).scrollTop;
    await sendPtyOutput(page, "new output while reviewing history\r\n");
    await expect(backToBottomNewIndicator(page)).toBeVisible();
    const scrollTopAfterNewFrame = (await readPtyScrollMetrics(page)).scrollTop;
    expect(scrollTopAfterNewFrame).toBeLessThanOrEqual(scrollTopBeforeNewFrame + 8);

    await backToBottom(page).click();
    await expect(backToBottom(page)).toHaveJSProperty("inert", true);
    await expectPtyAtBottom(page);

    const beforeApprovalStatusLine = await page.locator('[data-slot="status-line"]').boundingBox();
    expect(beforeApprovalStatusLine).not.toBeNull();
    const beforeApprovalChrome = await readPtyScrollMetrics(page);
    await setPtyState(page, "approval_wait");
    await expect(ptyApprovalHint(page)).toBeVisible();
    await expect(page.locator('[data-slot="status-line"]')).toHaveCount(0);
    const approvalHintBox = await ptyApprovalHint(page).boundingBox();
    expect(approvalHintBox).not.toBeNull();
    const expectedApprovalClientHeight =
      beforeApprovalChrome.clientHeight -
      (approvalHintBox!.height - beforeApprovalStatusLine!.height);
    await expect
      .poll(async () => (await readPtyScrollMetrics(page)).clientHeight)
      .toBeCloseTo(expectedApprovalClientHeight, 1);
    const afterApprovalChrome = await readPtyScrollMetrics(page);
    expect(afterApprovalChrome.clientHeight).toBeCloseTo(expectedApprovalClientHeight, 1);
    expect(afterApprovalChrome.scrollTop).toBeGreaterThan(0);
    expect(afterApprovalChrome.scrollTop).toBeGreaterThanOrEqual(
      beforeApprovalChrome.scrollTop - 8,
    );

    await resizePty(page, 100, 30);
    await expectPtyTerminalMounted(page);
    await expectPtySessionSubscribeCount(page, 2);
  });

  test("restores page-resume scroll to bottom after browser restores stale positions", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    await sendPtyLines(page, { count: 120, prefix: "resume-follow" });
    await expectPtyScrollable(page, 100);
    await expectPtyAtBottom(page);

    const staleBottomGap = await ptyTerminal(page).evaluate((el) => {
      window.dispatchEvent(new Event("pagehide"));
      const node = el as HTMLElement;
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      return maxScrollTop - node.scrollTop;
    });
    expect(staleBottomGap).toBeGreaterThan(100);

    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await expectPtyAtBottom(page);

    await scrollPtyToTop(page);
    await expect(backToBottom(page)).toBeVisible();

    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));

    await expectPtyAtBottom(page);
  });

  // longHost 模式 (rows*cellH > visible content height) 下, isAtBottom = cursorInViewport。
  // 用户 wheel up 一小段, cursor 仍可见 → atBottom 仍 true → bug 版 notifyAtBottom
  // 立刻清掉 intent → output flush → scrollToBottom 拉回。
  test("keeps user-scrolled position when remote keeps outputting after a small wheel-up (longHost)", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    // 拉到 longHost: rows=80 强制 hostHeight (rows*cellH) > container.clientHeight。
    // PC 默认 viewport ~720, cellH ~19 → 24 行 host=456 还在 short-host;  60 行 host=1140 进 longHost。
    await enterLongHostMode(page, { sessionId: SESSION_ID });

    // 输出大量行让 buffer.length > rows, 触发 longHost mode
    await sendPtyLines(page, { count: 80, prefix: "output line" });

    const terminal = ptyTerminal(page);
    await expectPtyScrollable(page, 100);

    // wheel up 小幅 — cursor 应仍在 viewport (longHost: 60 rows host > viewport, 但
    // viewport 末尾通常贴着光标行, 小 wheel 不会把 cursor 推出视野)
    await terminal.hover();
    await page.mouse.wheel(0, -80);
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeGreaterThan(0);

    // 远端继续输出: bug 版本 → notifyAtBottom 误清 intent → flushOutput → scrollToBottom 拉回
    for (let i = 0; i < 8; i++) {
      await sendPtyOutput(page, `continuous output ${i}\r\n`);
    }
    await expect
      .poll(async () => {
        const metrics = await readPtyScrollMetrics(page);
        return metrics.scrollTop < metrics.maxScrollTop - 30;
      })
      .toBe(true);

    const afterOutput = await readPtyScrollMetrics(page);
    // 期望 scrollTop 没被拉回贴底 (允许 scrollHeight 涨, scrollTop 跟新 max 应保留相对位置)
    expect(afterOutput.scrollTop).toBeLessThan(afterOutput.maxScrollTop - 30);
  });

  // 用户复现路径: 长 PTY 会话进入 /compact, 进度行不停 \r 重写 + 偶尔追加新行,
  // 屏幕几乎每帧都在重绘; 这时 wheel 上滚, 被持续输出"拉回"底部。
  // 跟前一条 longHost 测试的差别: 那条测试 wheel 完才输出 (顺序), 这条是
  // wheel 发生在 stream 进行中 (并发), pendingFrame 已经被排队 + RAF 还在
  // flush 的状态。
  test("does not pin to bottom when wheel-up occurs mid-stream of continuous PTY output (longHost, /compact pattern)", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_pty_scroll_trace", "1");
    });
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    await enterLongHostMode(page, { sessionId: SESSION_ID });

    // 先填一段历史让 longHost 真正生效 (host > viewport, 有可滚距离)
    await sendPtyLines(page, { count: 200, prefix: "history" });
    const terminal = ptyTerminal(page);
    await expectPtyScrollable(page, 500);

    // 启动 /compact 风格的连续输出: 每帧 \r 重写进度 + 频繁追加新行让
    // buffer 持续增长 (claude /compact 期间会输出 compacting messages 并不断新增进度行)。
    // 不 await, 让它跟后续 wheel 操作并发发生。
    const maxScrollTopBeforeStream = (await readPtyScrollMetrics(page)).maxScrollTop;
    await page.evaluate(() => {
      type AnyWindow = Window & { __ptyCompactRunning?: boolean; __ptyCompactTicks?: number };
      const w = window as AnyWindow;
      w.__ptyCompactRunning = true;
      w.__ptyCompactTicks = 0;
      let i = 0;
      const tick = (): void => {
        if (!w.__ptyCompactRunning) return;
        w.__ptyCompactTicks = (w.__ptyCompactTicks ?? 0) + 1;
        const idx = i++;
        // 每 4 帧追加一行新内容 (buffer.length 增长), 其余只 \r 重写
        const payload =
          idx % 4 === 3
            ? `\rcompacting ${idx}\r\nnew compacted message ${idx}\r\n`
            : `\rcompacting ${idx}`;
        window.__ptySmoke.sendPty(payload);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // 让 stream 进入稳态 (xterm 已经在 60Hz onRender + onFramePending), 并等
    // buffer 涨到足够大确保我们仍在 atBottom 时 max 已经显著 > 初始值
    await expect
      .poll(async () => {
        const [ticks, metrics] = await Promise.all([
          page.evaluate(
            () => (window as Window & { __ptyCompactTicks?: number }).__ptyCompactTicks ?? 0,
          ),
          readPtyScrollMetrics(page),
        ]);
        return ticks >= 5 && metrics.maxScrollTop > maxScrollTopBeforeStream + 30;
      })
      .toBe(true);

    // 用户复现是 wheel up 一次就有问题, 但单次 wheel 实际是 wheel event 序列 (~几个)。
    // 模拟用户连续 wheel 几次表达回看意图。
    await terminal.hover();
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -80);
      await waitForAnimationFrames(page, 1);
    }

    // 继续让 stream 跑一会, 看用户的 scrollTop 会不会被拉回去
    const ticksAfterWheel = await page.evaluate(
      () => (window as Window & { __ptyCompactTicks?: number }).__ptyCompactTicks ?? 0,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __ptyCompactTicks?: number }).__ptyCompactTicks ?? 0,
        ),
      )
      .toBeGreaterThanOrEqual(ticksAfterWheel + 10);

    await page.evaluate(() => {
      type AnyWindow = Window & { __ptyCompactRunning?: boolean };
      (window as AnyWindow).__ptyCompactRunning = false;
    });
    await waitForAnimationFrames(page, 2);

    const finalState = await readPtyScrollMetrics(page);
    expect(finalState.scrollTop).toBeLessThan(finalState.maxScrollTop - 30);
  });

  test("does not pin users to bottom when PTY output arrives during native touch scroll", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    await sendPtyLines(page, { count: 140, prefix: "stream line" });
    const terminal = ptyTerminal(page);
    await expectPtyScrollable(page);

    await ptyInput(page).focus();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .toBe("Terminal input");

    await terminal.evaluate((el) => {
      const touchstart = new Event("touchstart", { bubbles: true }) as TouchEvent;
      Object.defineProperty(touchstart, "touches", { value: [{ clientY: 520 }] });
      el.dispatchEvent(touchstart);
    });
    await sendPtyOutput(page, "frame-before-native-scroll\r\n");
    await terminal.evaluate((el) => {
      const touchmove = new Event("touchmove", { bubbles: true }) as TouchEvent;
      Object.defineProperty(touchmove, "touches", { value: [{ clientY: 580 }] });
      el.dispatchEvent(touchmove);
      const node = el as HTMLElement;
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.max(0, maxScrollTop - 600);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
      .not.toBe("Terminal input");
    const scrollTopBeforeNewFrame = (await readPtyScrollMetrics(page)).scrollTop;

    await sendPtyOutput(page, "frame-after-native-scroll\r\n");

    await expect(backToBottomNewIndicator(page)).toBeVisible();
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeLessThanOrEqual(scrollTopBeforeNewFrame + 80);
    const scrollAfterNewFrame = await readPtyScrollMetrics(page);
    expect(scrollAfterNewFrame.scrollTop).toBeLessThan(scrollAfterNewFrame.maxScrollTop - 30);
  });
});
