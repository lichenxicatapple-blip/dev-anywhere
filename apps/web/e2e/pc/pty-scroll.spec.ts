// PTY 滚动 e2e: back-to-bottom, 新消息提示, approval-wait 视图保持, resize 重新订阅,
// 触摸滚动期间不抢回底部.
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

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
    await expect(page.locator('[data-slot="back-to-bottom-new-indicator"]')).toBeVisible();
    const scrollTopAfterNewFrame = await page
      .locator('[data-slot="pty-terminal"]')
      .evaluate((el) => (el as HTMLElement).scrollTop);
    expect(scrollTopAfterNewFrame).toBeLessThanOrEqual(scrollTopBeforeNewFrame + 8);

    await page.locator('[data-slot="back-to-bottom"]').click();
    await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveJSProperty("inert", true);
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
    await page.evaluate(() => {
      window.__ptySmoke.resize(80, 60);
    });
    // 等 PTY 真的 resize 完: container.clientHeight 不动, 但 spacer.scrollHeight 跟 rows 走。
    // 必须按 sessionId 取 terminal — describe 跑多 spec 时 __ccTestPtyTerminals 会留旧 entry。
    await expect
      .poll(() =>
        page.evaluate(
          (sid) => window.__ccTestPtyTerminals?.get(sid)?.rows ?? 0,
          SESSION_ID,
        ),
      )
      .toBe(60);

    // 输出大量行让 buffer.length > rows, 触发 longHost mode
    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from({ length: 80 }, (_, i) => `output line ${String(i).padStart(3, "0")}\r\n`).join(
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
      .toBeGreaterThan(100);

    // wheel up 小幅 — cursor 应仍在 viewport (longHost: 60 rows host > viewport, 但
    // viewport 末尾通常贴着光标行, 小 wheel 不会把 cursor 推出视野)
    await terminal.hover();
    await page.mouse.wheel(0, -80);
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeGreaterThan(0);
    const scrollTopAfterWheel = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);

    // 远端继续输出: bug 版本 → notifyAtBottom 误清 intent → flushOutput → scrollToBottom 拉回
    for (let i = 0; i < 8; i++) {
      await page.evaluate((idx) => {
        window.__ptySmoke.sendPty(`continuous output ${idx}\r\n`);
      }, i);
    }
    await page.waitForTimeout(400);

    const afterOutput = await terminal.evaluate((el) => {
      const node = el as HTMLElement;
      return {
        scrollTop: node.scrollTop,
        max: node.scrollHeight - node.clientHeight,
      };
    });
    // 期望 scrollTop 没被拉回贴底 (允许 scrollHeight 涨, 但 scrollTop 跟着新 max 应保留
    // 用户原本停留的相对位置, 至少与原 scrollTopAfterWheel 不差太多)
    expect(afterOutput.scrollTop).toBeLessThan(afterOutput.max - 30);
  });

  // 用户复现路径: 长 PTY 会话进入 /compact, 进度行不停 \r 重写 + 偶尔追加新行,
  // 屏幕几乎每帧都在重绘; 这时 wheel 上滚, 被持续输出"拉回"底部。
  // 跟前一条 longHost 测试的差别: 那条测试 wheel 完才输出 (顺序), 这条是
  // wheel 发生在 stream 进行中 (并发), pendingFrame 已经被排队 + RAF 还在
  // flush 的状态。
  test("does not pin to bottom when wheel-up occurs mid-stream of continuous PTY output (longHost, /compact pattern)", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID, query: "&ptyScrollTrace=1" });
    await expectPtyTerminalMounted(page);

    await page.evaluate(() => {
      window.__ptySmoke.resize(80, 60);
    });
    await expect
      .poll(() =>
        page.evaluate((sid) => window.__ccTestPtyTerminals?.get(sid)?.rows ?? 0, SESSION_ID),
      )
      .toBe(60);

    // 先填一段历史让 longHost 真正生效 (host > viewport, 有可滚距离)
    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 200 },
          (_, i) => `history ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
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
      .toBeGreaterThan(500);

    // 启动 /compact 风格的连续输出: 每帧 \r 重写进度 + 频繁追加新行让
    // buffer 持续增长 (claude /compact 期间会输出 compacting messages 并不断新增进度行)。
    // 不 await, 让它跟后续 wheel 操作并发发生。
    await page.evaluate(() => {
      type AnyWindow = Window & { __ptyCompactRunning?: boolean };
      const w = window as AnyWindow;
      w.__ptyCompactRunning = true;
      let i = 0;
      const tick = (): void => {
        if (!w.__ptyCompactRunning) return;
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
    await page.waitForTimeout(220);

    // 用户复现是 wheel up 一次就有问题, 但单次 wheel 实际是 wheel event 序列 (~几个)。
    // 模拟用户连续 wheel 几次表达回看意图。
    await terminal.hover();
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -80);
      await page.waitForTimeout(40);
    }

    // 继续让 stream 跑一会, 看用户的 scrollTop 会不会被拉回去
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      type AnyWindow = Window & { __ptyCompactRunning?: boolean };
      (window as AnyWindow).__ptyCompactRunning = false;
    });
    await page.waitForTimeout(80);

    const finalState = await terminal.evaluate((el) => {
      const node = el as HTMLElement;
      return { scrollTop: node.scrollTop, max: node.scrollHeight - node.clientHeight };
    });
    expect(finalState.scrollTop).toBeLessThan(finalState.max - 30);
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

    await expect(page.locator('[data-slot="back-to-bottom-new-indicator"]')).toBeVisible();
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop))
      .toBeLessThanOrEqual(scrollTopBeforeNewFrame + 8);
  });
});
