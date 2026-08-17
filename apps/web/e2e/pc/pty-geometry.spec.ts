// PTY 几何 / 边界 e2e:
// 1. 小字号下 viewport 末端不留多余空隙 (xterm baseY 与 viewportY 对齐);
// 2. 容器横向 overflow 时鼠标拖拽到边缘自动横向滚屏 (autoscroll 模块端到端).
import { expect, test } from "@playwright/test";
import {
  expectPtyTerminalMounted,
  installPtyFakeRelay,
  readRawPtyInput,
  setupPtyChat,
} from "../pty-fixture";
import { BASE_URL, resetLocalState } from "../helpers";

const SESSION_ID = "pty-geometry";

test.describe("PTY geometry edges", () => {
  test("keeps snapshot geometry stable when session metadata has no size", async ({ page }) => {
    // session_list 故意不带 cols/rows，覆盖升级前已存在的会话；尺寸仍由历史协议中
    // 一直存在的 session_snapshot 恢复。
    await setupPtyChat(page, {
      sessionId: `${SESSION_ID}-session-owned`,
      sessionKind: "terminal",
      ptyOwner: "local-terminal",
      cols: 80,
      rows: 24,
      snapshotData: `${"QR".repeat(38)}\r\n$ `,
    });
    await expectPtyTerminalMounted(page);

    await expect
      .poll(() =>
        page.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          if (!term) return null;
          const wrappedLines = Array.from(
            { length: term.buffer.active.length },
            (_, index) => term.buffer.active.getLine(index)?.isWrapped === true,
          ).filter(Boolean).length;
          return { cols: term.cols, rows: term.rows, wrappedLines };
        }, `${SESSION_ID}-session-owned`),
      )
      .toEqual({ cols: 80, rows: 24, wrappedLines: 0 });

    await page.setViewportSize({ width: 390, height: 700 });
    await expect
      .poll(() =>
        page.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          if (!term) return null;
          const wrappedLines = Array.from(
            { length: term.buffer.active.length },
            (_, index) => term.buffer.active.getLine(index)?.isWrapped === true,
          ).filter(Boolean).length;
          return { cols: term.cols, rows: term.rows, wrappedLines };
        }, `${SESSION_ID}-session-owned`),
      )
      .toEqual({ cols: 80, rows: 24, wrappedLines: 0 });

    const resizeRequests = await page.evaluate(() =>
      window.__ptySmoke.sent.filter((raw) => {
        try {
          return (JSON.parse(raw) as { type?: string }).type === "terminal_resize_request";
        } catch {
          return false;
        }
      }),
    );
    expect(resizeRequests).toEqual([]);
  });

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

  test("keeps a short live host on one rendered frame while the user types", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 963 });
    // 37 x 18px is shorter than the 894px desktop content viewport. The final CRLF leaves one
    // meaningful row above the physical xterm bottom; moving the cursor up keeps the semantic
    // live viewport at baseY - 1, matching the field trace that jittered on every keystroke.
    const snapshotData =
      Array.from(
        { length: 1171 },
        (_, index) => `short host line ${String(index).padStart(4, "0")}\r\n`,
      ).join("") + "\x1b[3A";
    const sessionId = `${SESSION_ID}-short-host-input`;
    await setupPtyChat(page, {
      sessionId,
      sessionKind: "terminal",
      ptyOwner: "local-terminal",
      cols: 179,
      rows: 37,
      snapshotData,
    });
    await expectPtyTerminalMounted(page);

    await expect
      .poll(() =>
        page.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          const host = document.querySelector<HTMLElement>('[data-slot="pty-host"]');
          const debug = window.__devAnywherePtyDebug?.();
          if (!term || !host || !debug?.anchor.atBottom) return null;
          return {
            baseY: term.buffer.active.baseY,
            viewportY: term.buffer.active.viewportY,
            hostTop: host.style.top,
          };
        }, sessionId),
      )
      .not.toBeNull();
    const initial = await page.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const host = document.querySelector<HTMLElement>('[data-slot="pty-host"]');
      if (!term || !host) throw new Error("PTY geometry not ready");
      const samples: Array<{ eventY: number; viewportY: number; hostTop: string }> = [];
      term.onScroll((eventY) => {
        samples.push({
          eventY,
          viewportY: term.buffer.active.viewportY,
          hostTop: host.style.top,
        });
      });
      (
        window as unknown as {
          __ptyShortHostInputSamples: typeof samples;
        }
      ).__ptyShortHostInputSamples = samples;
      return {
        baseY: term.buffer.active.baseY,
        viewportY: term.buffer.active.viewportY,
        hostTop: host.style.top,
      };
    }, sessionId);
    expect(initial.baseY - initial.viewportY).toBe(1);

    const input = page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
    await input.focus();
    await page.keyboard.type("abcdef");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    const observed = await page.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      const host = document.querySelector<HTMLElement>('[data-slot="pty-host"]');
      const samples = (
        window as unknown as {
          __ptyShortHostInputSamples?: Array<{
            eventY: number;
            viewportY: number;
            hostTop: string;
          }>;
        }
      ).__ptyShortHostInputSamples;
      if (!term || !host || !samples) throw new Error("PTY input samples missing");
      return {
        samples,
        viewportY: term.buffer.active.viewportY,
        hostTop: host.style.top,
      };
    }, sessionId);

    expect(observed.viewportY).toBe(initial.viewportY);
    expect(observed.hostTop).toBe(initial.hostTop);
    expect(observed.samples.every((sample) => sample.eventY === initial.viewportY)).toBe(true);
    expect(observed.samples.every((sample) => sample.hostTop === initial.hostTop)).toBe(true);
    expect(await readRawPtyInput(page)).toContain("abcdef");
  });

  // 用户横向滚动后, followCursorX 不应在 onRender 时把 scrollLeft 拉回光标位置。
  // bug 表现 (修复前): 横向溢出场景, 用户主动滚到光标视窗外, 任意一次 PTY 输出 /
  // cursor blink 触发 onRender, scrollLeft 被强行写回光标位置, 用户感受到"无形力量"。
  test("does not snap horizontal scroll back to cursor after user scrolls away", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    // 撑横向 overflow (spacer 2000px), cursor 默认在 col 0 / cursorPxX=0
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

    // 用户主动横向滚到中段 — viewport 不再包含 col 0 (cursor 所在位置)
    const userScrollLeft = 500;
    await terminal.evaluate((el, target) => {
      (el as HTMLElement).scrollLeft = target;
    }, userScrollLeft);
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollLeft))
      .toBe(userScrollLeft);

    // 触发若干 onRender — PTY 增量输出会让 cursor 从 col 0 推进到 col N。N 仍小于 viewport
    // 即使 cursor 不在 viewport 内，增量输出也不应覆盖用户主动设置的横向位置。
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__ptySmoke.sendPty("B"));
    }

    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const finalScrollLeft = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
    expect(finalScrollLeft).toBe(userScrollLeft);
  });

  // PTY 容器横向有 overflow 时, 鼠标拖拽到边缘应该自动横向滚屏。
  //
  // 这条 e2e 钉死容器层的可观测行为 (scrollLeft 真的动了, autoscroll 模块在真 DOM 真
  // Playwright pointer event 下生效)。**没有**断 xterm SelectionService 的选区扩展,
  // 因为:
  //   (1) xterm 的 .xterm-screen 上面叠了 .xterm-link-layer canvas, 完全盖住 click 落点,
  //       Playwright 真 mousedown 都到不了 .xterm-screen 上的 listener
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

    // 拖到右边缘 (距右沿 5px), 进入 EDGE_PX (28) 区域, autoscroll 多帧推 scrollLeft.
    // 等 scrollLeft 真的越过 initialScrollLeft 而不硬等固定毫秒.
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 8 });
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollLeft))
      .toBeGreaterThan(initialScrollLeft);
    const scrolledRight = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);

    // 拖回左边缘, scrollLeft 回退到比 scrolledRight 小.
    await page.mouse.move(box.x + 5, box.y + box.height / 2, { steps: 8 });
    await expect
      .poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollLeft))
      .toBeLessThan(scrolledRight);
    const scrolledBack = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
    expect(scrolledBack).toBeLessThan(scrolledRight);

    // pointerup 后停 raf, scrollLeft 不再变化. 取若干次采样检查稳态.
    await page.mouse.up();
    const afterUp = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
    for (let i = 0; i < 5; i++) {
      const sample = await terminal.evaluate((el) => (el as HTMLElement).scrollLeft);
      expect(sample).toBe(afterUp);
    }
  });
});
