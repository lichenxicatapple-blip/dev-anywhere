import { expect, mobileBaseUrl, test } from "../fixtures/cdp";
import { installFakeRelay, sentFakeRelayMessages } from "../helpers";
import { expectNoHorizontalDocumentOverflow } from "../mobile-helpers";
import { dismissSoftKeyboard, tapWithAdb, waitForSoftKeyboard } from "./pty-soft-keyboard";

test.describe("L4 mobile / JSON chat keyboard and bubble layout", () => {
  test.setTimeout(90_000);

  test.afterEach(async ({ emuPage }) => {
    await dismissSoftKeyboard(emuPage);
  });

  test("keeps the complete composer above the Android keyboard toolbar", async ({ emuPage }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();

    const input = emuPage.getByLabel("输入聊天消息");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await tapWithAdb(input);
    await waitForSoftKeyboard(emuPage);

    await expect
      .poll(
        () =>
          emuPage.evaluate(() => {
            const card = document.querySelector<HTMLElement>('[data-slot="input-card"]');
            if (!card) return Number.NEGATIVE_INFINITY;
            const visualViewport = window.visualViewport;
            const visualBottom =
              (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? window.innerHeight);
            return visualBottom - card.getBoundingClientRect().bottom;
          }),
        { timeout: 10_000, message: "JSON composer did not settle above Android keyboard" },
      )
      .toBeGreaterThanOrEqual(20);

    const geometry = await emuPage.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-slot="input-card"]');
      const attach = document.querySelector<HTMLElement>('[data-slot="input-attach-button"]');
      const send = document.querySelector<HTMLElement>('[data-slot="send-button"]');
      if (!card || !attach || !send) throw new Error("composer controls missing");
      const visualViewport = window.visualViewport;
      const visualBottom =
        (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? window.innerHeight);
      return {
        gap: visualBottom - card.getBoundingClientRect().bottom,
        cardBottom: card.getBoundingClientRect().bottom,
        attachBottom: attach.getBoundingClientRect().bottom,
        sendBottom: send.getBoundingClientRect().bottom,
      };
    });
    expect(geometry.gap).toBeGreaterThanOrEqual(20);
    expect(geometry.attachBottom).toBeLessThanOrEqual(geometry.cardBottom + 1);
    expect(geometry.sendBottom).toBeLessThanOrEqual(geometry.cardBottom + 1);
  });

  test("wraps long message bubbles without overflowing the mobile viewport", async ({
    emuPage,
  }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();
    await expect(emuPage.getByLabel("输入聊天消息")).toBeVisible({ timeout: 30_000 });

    await emuPage.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      const token = "very-long-unbroken-message-token-".repeat(16);
      hooks.chat.loadHistory("test-sess", [
        { role: "system", text: token, timestamp: Date.now() },
        { role: "user", text: token, timestamp: Date.now() + 1 },
        { role: "assistant", text: token, timestamp: Date.now() + 2 },
      ]);
    });

    const bubbles = emuPage.locator(
      '[data-slot="message-body"], [data-slot="message-system-marker"]',
    );
    await expect(bubbles).toHaveCount(3);
    await expectNoHorizontalDocumentOverflow(emuPage);

    const geometry = await bubbles.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      }),
    );
    for (const item of geometry) {
      expect(item.left).toBeGreaterThanOrEqual(0);
      expect(item.right).toBeLessThanOrEqual(item.viewportWidth + 1);
      expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1);
    }
  });

  test("keeps a wrapped JSON bubble file link tappable for download", async ({ emuPage }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();
    await expect(emuPage.getByLabel("输入聊天消息")).toBeVisible({ timeout: 30_000 });

    const path = "deep/" + "very-long-directory/".repeat(10) + "README.md";
    await emuPage.evaluate((filePath) => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      hooks.chat.appendAssistantText(
        "test-sess",
        `这是一个需要在移动端气泡中换行显示的较长文件路径： ${filePath}`,
      );
      hooks.chat.markTurnComplete("test-sess");
    }, path);

    const link = emuPage.locator('[data-slot="inline-file-download-link"]', { hasText: path });
    await expect(link).toBeVisible();
    const touchPoint = await link.evaluate((element) => {
      const candidates = [...element.getClientRects()]
        .filter(
          (rect) =>
            rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.top < window.innerHeight,
        )
        .flatMap((rect) =>
          [0.25, 0.5, 0.75].map((ratio) => ({
            x: rect.left + rect.width * ratio,
            y: rect.top + rect.height / 2,
          })),
        );
      return (
        candidates.find((point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit === element || (hit !== null && element.contains(hit));
        }) ?? null
      );
    });
    if (!touchPoint) throw new Error("wrapped download link has no touch geometry");
    await link.click();

    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(emuPage)).some(
          (message) =>
            message.type === "remote_file_url_request" &&
            message.sessionId === "test-sess" &&
            message.path === path &&
            message.disposition === "download",
        ),
      )
      .toBe(true);
  });
});
