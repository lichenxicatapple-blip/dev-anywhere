// PTY 渲染层对乱序 / 过期 / 重复帧的防御 e2e (故障注入维度,
// 与功能性 PTY 行为分到 chaos/ 子目录).
import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../../pty-fixture";
import { expectPtyRendered } from "../../pty-scroll-helpers";

const SESSION_ID = "pty-render-chaos";

test.describe("PTY render chaos: stale render snapshots and outputSeq dedupe", () => {
  test("ignores stale render snapshots and reorders duplicate PTY frames by outputSeq", async ({
    page,
  }) => {
    await setupPtyChat(page, {
      sessionId: SESSION_ID,
      sessionKind: "agent",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
    });
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

    await expectPtyRendered(page);
    const renderedRows = page.locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows');
    await expect(renderedRows).toContainText("SEQ-1");
    await expect(renderedRows).toContainText("SEQ-2");
    await expect(renderedRows).toContainText("SEQ-3");
    await expect(renderedRows).toContainText("SEQ-4");
    await expect(renderedRows).not.toContainText("STALE SNAPSHOT SHOULD NOT RENDER");
  });

  test("keeps a large synchronized redraw, resize, and following output in one live stream", async ({
    page,
  }) => {
    await setupPtyChat(page, {
      sessionId: SESSION_ID,
      sessionKind: "agent",
      provider: "claude",
      ptyOwner: "proxy-hosted",
      cols: 80,
      rows: 24,
    });
    await expectPtyTerminalMounted(page);
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain("PTY SMOKE READY");

    const initialSubscribeCount = await page.evaluate(
      () =>
        window.__ptySmoke.sent.filter((raw) => {
          try {
            return (JSON.parse(raw) as { type?: string }).type === "session_subscribe";
          } catch {
            return false;
          }
        }).length,
    );

    await page.evaluate(() => {
      const redrawBody = Array.from(
        { length: 3_500 },
        (_, index) => `redraw-${index.toString().padStart(4, "0")}-${"x".repeat(84)}\r\n`,
      ).join("");
      const kimiStyleRedraw = `\x1b[?2026h\x1b[2J\x1b[H${redrawBody}KIMI-REDRAW-COMMITTED\r\n\x1b[?2026l`;

      window.__ptySmoke.sendPty(kimiStyleRedraw);
      // emitResize crosses the JSON event loop while the following binary frame arrives now. The
      // recovery layer must reconstruct seq=redraw, seq=resize, seq=latest before touching xterm.
      window.__ptySmoke.resize(100, 30);
      window.__ptySmoke.sendPty("LATEST-AFTER-RESIZE\r\n");
    });

    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain("KIMI-REDRAW-COMMITTED");
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
      .toContain("LATEST-AFTER-RESIZE");
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.metrics(sid) ?? null, SESSION_ID))
      .toMatchObject({ cols: 100, rows: 30 });

    const finalSubscribeCount = await page.evaluate(
      () =>
        window.__ptySmoke.sent.filter((raw) => {
          try {
            return (JSON.parse(raw) as { type?: string }).type === "session_subscribe";
          } catch {
            return false;
          }
        }).length,
    );
    expect(finalSubscribeCount).toBe(initialSubscribeCount);
  });
});
