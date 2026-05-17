// 复现 user 反馈的 PTY 滚回底冻结现象:
//   1. PTY 持续输出
//   2. wheel 上滚离开底部 → output 被 paused
//   3. paused 期间 server 端继续 sendPty (frame writer 累积)
//   4. wheel 滚回底部 → 期望 intent 释放 + output 恢复 + 探针行可见
//
// 如果 bug 在 e2e 能复现, 这条 spec 就是 fail; 修好之后变 green。
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

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

    // page.mouse.wheel 走真 wheel 事件路径, 比 dispatchEvent 更接近真实交互。
    const termBox = await terminal.boundingBox();
    if (!termBox) throw new Error("terminal not found");
    await page.mouse.move(termBox.x + termBox.width / 2, termBox.y + termBox.height / 2);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -120);
    }

    // wheel 后继续 sendPty: paused 路径下 frameWriter 在 pendingBytes 累积。
    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 10 }, (_, i) => `mid ${String(i).padStart(2, "0")}\r\n`).join(""),
      );
    });

    // 小 wheel 滚回底部 (跟 user trace 同节奏)。
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 120);
    }

    // 探针: 滚回底之后再 sendPty 一行, 必须能在合理时间内看见 (说明渲染没冻)。
    await page.evaluate((token) => {
      window.__ptySmoke.sendPty(`=== ${token} ===\r\n`);
    }, PROBE_TOKEN);

    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID), {
        timeout: 10_000,
      })
      .toContain(PROBE_TOKEN);
  });
});
