// 复现 user 反馈的 PTY 滚回底冻结现象:
//   1. PTY 持续输出
//   2. wheel 上滚离开底部 → 进入 review, 但 output 仍持续写入 xterm
//   3. review 期间 server 端继续 sendPty → buffer 更新且用户位置保持
//   4. wheel 滚回底部 → 期望恢复自动跟随 + 探针行可见
//
// 如果 bug 在 e2e 能复现, 这条 spec 就是 fail; 修好之后变 green。
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import {
  expectPtyCursorAwareBottom,
  expectPtyRendered,
  readPtyScrollMetrics,
} from "../pty-scroll-helpers";

const SESSION_ID = "pty-scrollback-resume";
const PROBE_TOKEN = "PROBE-AFTER-SCROLLBACK-RESUME";

test.describe("PTY scrollback resume", () => {
  // 小视口 + 大 rows 强制 longHost (host 比 visibleContent 高), 这条 isAtBottom
  // 路径取 cursorInViewport, 跟 user trace 现场一致。默认 device-pc 的视口里
  // host < visibleContent 走 simple 路径, atBottom 跟 scrollTop 直接相关, 反而
  // 跑不到本 bug 的卡死。
  test.use({ viewport: { width: 800, height: 400 } });

  test("output renders again after wheel up + wheel back to bottom mid-stream", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID, withVisualViewportMock: true });
    await expectPtyTerminalMounted(page);
    // resize 让 PTY 行数比视口能放下的多, 走 longHost 分支。
    await page.evaluate(() => window.__ptySmoke.resize(80, 40));

    // 初始内容: 200 行, 让 buffer 远高过视口, 才有滚动空间。
    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, "0")}\r\n`).join(""),
      );
    });
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain("line 199");

    const terminal = page.locator('[data-slot="pty-terminal"]');
    await expectPtyCursorAwareBottom(page);
    const liveBottomBeforeReview = (await readPtyScrollMetrics(page)).scrollTop;

    // page.mouse.wheel 走真 wheel 事件路径, 比 dispatchEvent 更接近真实交互。
    const termBox = await terminal.boundingBox();
    if (!termBox) throw new Error("terminal not found");
    await page.mouse.move(termBox.x + termBox.width / 2, termBox.y + termBox.height / 2);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -120);
    }
    await expectPtyRendered(page);
    const reviewedScrollTop = await terminal.evaluate((node) => node.scrollTop);

    // 回看期间持续写 xterm，不能把输出藏在前端队列里等下一次用户交互唤醒。
    await page.evaluate(() => {
      const current = window as Window & {
        __ptyScrollbackOutputCount?: number;
        __ptyScrollbackOutputTimer?: number;
      };
      current.__ptyScrollbackOutputCount = 0;
      current.__ptyScrollbackOutputTimer = window.setInterval(() => {
        const index = current.__ptyScrollbackOutputCount ?? 0;
        window.__ptySmoke.sendPty(`mid ${String(index).padStart(2, "0")}\r\n`);
        current.__ptyScrollbackOutputCount = index + 1;
      }, 20);
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __ptyScrollbackOutputCount?: number })
              .__ptyScrollbackOutputCount ?? 0,
        ),
      )
      .toBeGreaterThanOrEqual(10);
    const appendedCount = await page.evaluate(() => {
      const current = window as Window & {
        __ptyScrollbackOutputCount?: number;
        __ptyScrollbackOutputTimer?: number;
      };
      if (current.__ptyScrollbackOutputTimer !== undefined) {
        window.clearInterval(current.__ptyScrollbackOutputTimer);
        delete current.__ptyScrollbackOutputTimer;
      }
      return current.__ptyScrollbackOutputCount ?? 0;
    });
    const lastMidToken = `mid ${String(appendedCount - 1).padStart(2, "0")}`;
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain(lastMidToken);
    expect(await terminal.evaluate((node) => node.scrollTop)).toBeCloseTo(reviewedScrollTop, 0);
    await expectPtyRendered(page);
    await expect(page.locator('[data-slot="pty-review-snapshot"]')).toHaveCount(0);

    const currentBottom = await readPtyScrollMetrics(page);
    expect(currentBottom.maxScrollTop).toBeGreaterThan(liveBottomBeforeReview + 100);
    const cellHeight = await page
      .locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows > div')
      .first()
      .evaluate((row) => row.getBoundingClientRect().height);

    // Ordinary wheel input must walk through the buffer that grew while the user was reading.
    // Crossing the old live bottom is not permission to jump to the new one; only the explicit
    // "back to latest" action may skip intermediate rows.
    let crossedOldBottomWhileStillReviewing = false;
    for (let i = 0; i < 24; i++) {
      const beforeStep = await readPtyScrollMetrics(page);
      if (beforeStep.bottomGap <= 8) break;
      await page.mouse.wheel(0, 120);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const afterStep = await readPtyScrollMetrics(page);
      const travel = afterStep.scrollTop - beforeStep.scrollTop;
      expect(
        travel,
        `wheel step ${i + 1} must not jump to the latest output`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        travel,
        `wheel step ${i + 1} must remain proportional to its input`,
      ).toBeLessThanOrEqual(120 + cellHeight + 2);
      if (
        beforeStep.scrollTop < liveBottomBeforeReview - 8 &&
        afterStep.scrollTop >= liveBottomBeforeReview - 8
      ) {
        expect(afterStep.bottomGap).toBeGreaterThan(8);
        crossedOldBottomWhileStillReviewing = true;
      }
    }
    expect(crossedOldBottomWhileStillReviewing).toBe(true);
    await expectPtyCursorAwareBottom(page);

    // 探针: 滚回底之后再 sendPty 一行, 必须能在合理时间内看见 (说明渲染没冻)。
    await page.evaluate((token) => {
      window.__ptySmoke.sendPty(`=== ${token} ===\r\n`);
    }, PROBE_TOKEN);

    await expect(page.locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows')).toContainText(
      PROBE_TOKEN,
    );
    await expectPtyCursorAwareBottom(page);
  });
});
