// PTY 几何 / 边界 e2e:
// 1. 小字号下 viewport 末端不留多余空隙 (xterm baseY 与 viewportY 对齐);
// 2. 容器横向 overflow 时鼠标拖拽到边缘自动横向滚屏 (autoscroll 模块端到端).
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, installPtyFakeRelay, setupPtyChat } from "../pty-fixture";
import { BASE_URL, resetLocalState } from "../helpers";

const SESSION_ID = "pty-geometry";

test.describe("PTY geometry edges", () => {
  test("keeps xterm at the real last viewport when small fonts leave extra vertical space", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_ptyFontSize", "10");
    });
    // setupPtyChat 内部不带字号配置, 但 init 顺序需要先 ptyFontSize 再 fakeRelay.
    // 这里手动复制 setupPtyChat 的 init+reload+resetLocal 双跑流程.
    await installPtyFakeRelay(page, { sessionId: SESSION_ID });
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await resetLocalState(page);
    await installPtyFakeRelay(page, { sessionId: SESSION_ID });
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);

    await expectPtyTerminalMounted(page);
    await page.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 220 },
          (_, i) => `small font line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.metrics(sid)?.fontSize, SESSION_ID))
      .toBe(10);

    await page.locator('[data-slot="pty-terminal"]').hover();
    await page.mouse.wheel(0, -1800);
    await expect
      .poll(() =>
        page.locator('[data-slot="pty-terminal"]').evaluate((el) => {
          const node = el as HTMLElement;
          return node.scrollHeight - node.clientHeight - node.scrollTop;
        }),
      )
      .toBeGreaterThan(0);

    await page.mouse.wheel(0, 5000);
    await expect
      .poll(() =>
        page.evaluate((sid) => {
          const node = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
          const term = window.__ccTestPtyTerminals?.get(sid);
          if (!node || !term) return null;
          return {
            bottomGap: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop),
            viewportY: term.buffer.active.viewportY,
            baseY: term.buffer.active.baseY,
          };
        }, SESSION_ID),
      )
      .toEqual(expect.objectContaining({ bottomGap: 0, viewportY: expect.any(Number) }));

    const metrics = await page.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      return term
        ? { viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY }
        : null;
    }, SESSION_ID);
    expect(metrics?.viewportY).toBe(metrics?.baseY);
  });

  // PTY 容器横向有 overflow 时, 鼠标拖拽到边缘应该自动横向滚屏。
  //
  // 这条 e2e 钉死容器层的可观测行为 (scrollLeft 真的动了, autoscroll 模块在真 DOM 真
  // Playwright pointer event 下生效)。**没有**断 xterm SelectionService 的选区扩展,
  // 因为:
  //   (1) xterm WebGL 模式 .xterm-screen 上面叠了 .xterm-link-layer canvas, 完全盖住
  //       click 落点, Playwright 真 mousedown 都到不了 .xterm-screen 上的 listener
  //       (probe 实测 mousedownTrusted=0)。
  //   (2) 自己用 dispatchEvent 派 untrusted mousedown 倒是能上 .xterm-screen, 但
  //       xterm SelectionService 对 untrusted MouseEvent 不响应, 选区不启动。
  // 选区扩展那一段的覆盖在两个层面: 单测 (pty-drag-select-autoscroll.test.ts 钉死合成
  // mousemove 派发目标 = .xterm-screen, 这是 ca44767b 修的 critical bug 的核心)
  // + 用户真实环境手动验证。
  test("auto-scrolls horizontally during mouse drag past container edges", async ({ page }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    // 直接撑 spacer 让容器横向溢出, 不依赖 xterm cols × cellW 那条易碎的链路
    await page.evaluate(() => {
      const spacer = document.querySelector<HTMLElement>('[data-slot="pty-spacer"]');
      if (!spacer) throw new Error("pty-spacer not mounted");
      spacer.style.width = "2000px";
      spacer.style.minWidth = "2000px";
    });

    const terminal = page.locator('[data-slot="pty-terminal"]');
    await expect
      .poll(() =>
        terminal.evaluate(
          (el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth,
        ),
      )
      .toBe(true);

    const initialScrollLeft = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
    expect(initialScrollLeft).toBe(0);

    const box = await terminal.boundingBox();
    if (!box) throw new Error("pty terminal has no bounding box");

    // 拖到右边缘 (距右沿 5px), 进入 EDGE_PX (28) 区域, autoscroll 多帧推 scrollLeft
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(400);

    const scrolledRight = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
    expect(scrolledRight).toBeGreaterThan(initialScrollLeft);

    // 拖回左边缘, scrollLeft 回退 (用户的真实复现路径: \r 把光标拉回行首)
    await page.mouse.move(box.x + 5, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(400);
    const scrolledBack = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
    expect(scrolledBack).toBeLessThan(scrolledRight);

    // pointerup 后停 raf, scrollLeft 不再变化
    await page.mouse.up();
    const afterUp = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
    await page.waitForTimeout(200);
    const stillSame = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
    expect(stillSame).toBe(afterUp);
  });
});
