// PTY 模式工具审批状态在移动端 UI: pty_state=approval_wait 应让 pty-approval-hint
// 浮起且不水平溢出, 视图位置不被推到顶.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { setupPtyChat, expectPtyTerminalMounted } from "../pty-fixture";
import { expectNoHorizontalDocumentOverflow } from "../mobile-helpers";

const SESSION_ID = "mobile-pty-approval";

test.describe("L4 mobile / PTY approval hint", () => {
  test.setTimeout(60_000);

  test("pty_state=approval_wait surfaces hint touch-safely without overflow", async ({
    emuPage,
  }) => {
    await setupPtyChat(emuPage, { sessionId: SESSION_ID, baseUrl: mobileBaseUrl });
    await expectPtyTerminalMounted(emuPage, { timeout: 30_000 });

    await emuPage.evaluate(() => {
      window.__ptySmoke.sendPty(Array.from({ length: 60 }, (_, i) => `output ${i}\r\n`).join(""));
    });

    await emuPage.evaluate(() => window.__ptySmoke.setPtyState("approval_wait"));

    const hint = emuPage.locator('[data-slot="pty-approval-hint"]');
    await expect(hint).toBeVisible();
    await expectNoHorizontalDocumentOverflow(emuPage);

    // 切换回 working, hint 应消失.
    await emuPage.evaluate(() => window.__ptySmoke.setPtyState("working"));
    await expect(hint).toHaveCount(0);
  });
});
