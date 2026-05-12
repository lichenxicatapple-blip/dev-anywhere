// PTY 渲染层对乱序 / 过期 / 重复帧的防御 e2e (故障注入维度,
// 与功能性 PTY 行为分到 chaos/ 子目录).
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";

const SESSION_ID = "pty-render-chaos";

test.describe("PTY render chaos: stale render snapshots and outputSeq dedupe", () => {
  test("ignores stale render snapshots and reorders duplicate PTY frames by outputSeq", async ({
    page,
  }) => {
    await setupPtyChat(page, { sessionId: SESSION_ID });
    await expectPtyTerminalMounted(page);

    await page.evaluate((sessionId) => {
      window.__ptySmoke.socket?.emitJson({
        type: "session_snapshot",
        sessionId,
        requestId: "stale-request",
        cols: 80,
        rows: 24,
        data: "STALE SNAPSHOT SHOULD NOT RENDER\r\n",
        outputSeq: 99,
      });
      window.__ptySmoke.sendPtyWithSeq("SEQ-2\r\n", 2);
      window.__ptySmoke.sendPtyWithSeq("SEQ-1\r\n", 1);
      window.__ptySmoke.sendPtyWithSeq("DUPLICATE-SEQ-1-SHOULD-NOT-RENDER\r\n", 1);
      window.__ptySmoke.sendPtyWithSeq("OLDER-SEQ-0-SHOULD-NOT-RENDER\r\n", 0);
      window.__ptySmoke.sendPtyWithSeq("DUPLICATE-SEQ-2-SHOULD-NOT-RENDER\r\n", 2);
      window.__ptySmoke.sendPtyWithSeq("SEQ-4\r\n", 4);
      window.__ptySmoke.sendPtyWithSeq("SEQ-3\r\n", 3);
    }, SESSION_ID);

    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain("SEQ-4");

    const screen = await page.evaluate(
      (sid) => window.__ccTest?.pty.serialize(sid) ?? "",
      SESSION_ID,
    );
    const seq1Index = screen.indexOf("SEQ-1");
    const seq2Index = screen.indexOf("SEQ-2");
    const seq3Index = screen.indexOf("SEQ-3");
    const seq4Index = screen.indexOf("SEQ-4");
    expect(screen).toContain("SEQ-1");
    expect(screen).toContain("SEQ-2");
    expect(screen).toContain("SEQ-3");
    expect(screen).toContain("SEQ-4");
    expect(seq1Index).toBeLessThan(seq2Index);
    expect(seq2Index).toBeLessThan(seq3Index);
    expect(seq3Index).toBeLessThan(seq4Index);
    expect(screen).not.toContain("STALE SNAPSHOT SHOULD NOT RENDER");
    expect(screen).not.toContain("DUPLICATE-SEQ-1-SHOULD-NOT-RENDER");
    expect(screen).not.toContain("OLDER-SEQ-0-SHOULD-NOT-RENDER");
    expect(screen).not.toContain("DUPLICATE-SEQ-2-SHOULD-NOT-RENDER");
  });
});
