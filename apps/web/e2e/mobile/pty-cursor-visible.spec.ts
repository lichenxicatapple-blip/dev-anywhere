// 防"光标在视野外"事故 (commit 1864a268). 真 Android emu Chrome + 长 buffer cold-start
// 场景, 钉死 cold-start 后 viewportY === baseY (cursor 在 viewport 末端) +
// xterm 的隐形 textarea (跟 cursor 同步) 真在 pty-terminal 容器内.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";

const SESSION_ID = "mobile-pty-cursor";

test.describe("L4 mobile / PTY cursor visibility", () => {
  test.setTimeout(60_000);

  test("keeps cursor inside viewport on cold-start with a long buffer", async ({ emuPage }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    // emu Chrome 上 vite 首次加载 + xterm 初始化比 host 桌面 chromium 慢, 拉长.
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    // 长 buffer 让 host (rows * cellH) > visibleContentHeight, 触发 anchor 决策.
    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(
        Array.from(
          { length: 220 },
          (_, i) => `mobile cursor smoke line ${String(i).padStart(3, "0")}\r\n`,
        ).join(""),
      );
    });

    await expect
      .poll(() =>
        emuPage.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          if (!term) return null;
          return {
            viewportY: term.buffer.active.viewportY,
            baseY: term.buffer.active.baseY,
          };
        }, SESSION_ID),
      )
      .toEqual(
        expect.objectContaining({
          viewportY: expect.any(Number),
          baseY: expect.any(Number),
        }),
      );

    const metrics = await emuPage.evaluate((sid) => {
      const term = window.__ccTestPtyTerminals?.get(sid);
      if (!term) return null;
      return { viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY };
    }, SESSION_ID);
    expect(metrics).toBeTruthy();
    // 1864a268 之前 viewportY 会停在 baseY 之前 (host > visible 时 anchor 几何贴底
    // 误吸 trailing 空行), cursor 在 viewport 之外. 修后 viewportY === baseY.
    expect(metrics!.viewportY).toBe(metrics!.baseY);

    // textarea 跟 xterm cursor 同步移动 (用于 IME). Android Chrome 偶发把 helper
    // textarea 的元素高度伸出 terminal 半行, 因此这里检查 cursor 锚点 top 落在
    // terminal 内, 而不是把 helper 元素的 bottom 当成真实光标边界。
    const textareaBox = await emuPage
      .locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]')
      .boundingBox();
    const containerBox = await emuPage.locator('[data-slot="pty-terminal"]').boundingBox();
    expect(textareaBox).toBeTruthy();
    expect(containerBox).toBeTruthy();
    expect(textareaBox!.y).toBeGreaterThanOrEqual(containerBox!.y - 4);
    expect(textareaBox!.y).toBeLessThanOrEqual(containerBox!.y + containerBox!.height + 4);
  });
});
