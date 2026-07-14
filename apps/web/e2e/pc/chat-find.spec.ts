import { expect, test } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "../helpers";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";
import { ptyInput, readPtyScrollMetrics, sendPtyOutput } from "../pty-scroll-helpers";

test.describe("会话内查找", () => {
  test("气泡模式会拉取完整历史并定位虚拟列表中的消息", async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/hist-sess?mode=json`);

    const chatInput = page.getByLabel("输入聊天消息");
    await expect(chatInput).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("移动端历史问题：请检查 JSON 渲染。")).toBeVisible();
    await expect(page.getByText("更早历史 01")).toHaveCount(0);
    await chatInput.focus();

    await page.keyboard.press("Control+f");
    const findInput = page.getByRole("searchbox", { name: "查找内容" });
    await expect(findInput).toBeFocused();
    await findInput.fill("更早历史 01");

    await expect(page.locator('[data-slot="chat-find-results"]')).toHaveText("1 / 1");
    await expect(page.locator('[data-slot="message-row"][data-find-active="true"]')).toContainText(
      "更早历史 01",
    );
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page)).filter(
            (message) =>
              message.type === "session_messages_request" &&
              message.sessionId === "hist-sess" &&
              message.before === "hist-before-13",
          ).length,
      )
      .toBe(1);

    await findInput.fill("这是一条用于移动端上滑分页冒烟");
    await expect(page.locator('[data-slot="chat-find-results"]')).toHaveText("1 / 26");
    await findInput.press("Enter");
    await expect(page.locator('[data-slot="chat-find-results"]')).toHaveText("2 / 26");

    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="chat-find-bar"]')).toHaveCount(0);
    await expect(chatInput).toBeFocused();

    await page.keyboard.press("Meta+f");
    await expect(findInput).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="chat-find-bar"]')).toHaveCount(0);
  });

  test("PTY 模式跨滚屏定位且不会把查找按键发给远端", async ({ page }) => {
    const sessionId = "pty-find";
    await setupPtyChat(page, { sessionId });
    await expectPtyTerminalMounted(page);

    const lines = Array.from({ length: 140 }, (_, index) => {
      if (index === 10) return "SEARCH NEEDLE OLD";
      if (index === 110) return "SEARCH NEEDLE NEW";
      return `terminal output ${String(index).padStart(3, "0")}`;
    });
    await sendPtyOutput(page, `${lines.join("\r\n")}\r\n$ `);
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", sessionId))
      .toContain("SEARCH NEEDLE NEW");

    const terminalInput = ptyInput(page);
    await terminalInput.focus();
    const rawInputBeforeFind = await readRawPtyInput(page);
    await page.keyboard.press("Control+f");

    const findInput = page.getByRole("searchbox", { name: "查找内容" });
    await expect(findInput).toBeFocused();
    await findInput.pressSequentially("SEARCH NEEDLE");
    const resultLabel = page.locator('[data-slot="chat-find-results"]');
    await expect(resultLabel).toHaveText("1 / 2");
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.getSelection(sid) ?? "", sessionId))
      .toBe("SEARCH NEEDLE");
    await expect
      .poll(() => readPtyScrollMetrics(page).then((metrics) => metrics.bottomGap))
      .toBeGreaterThan(100);
    expect(await readRawPtyInput(page)).toBe(rawInputBeforeFind);

    await findInput.press("Enter");
    await expect(resultLabel).toHaveText("2 / 2");
    expect(await readRawPtyInput(page)).toBe(rawInputBeforeFind);

    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="chat-find-bar"]')).toHaveCount(0);
    await expect(terminalInput).toBeFocused();
    await expect
      .poll(() => page.evaluate((sid) => window.__ccTest?.pty.getSelection(sid) ?? "", sessionId))
      .toBe("");
  });

  test("窄屏可从会话菜单打开查找并定位命中气泡", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installFakeRelay(page);
    await selectFakeProxy(page);
    await page.goto(`${BASE_URL}/#/chat/hist-sess?mode=json`);

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.locator('[data-slot="chat-menu-find"]').click();
    const findInput = page.getByRole("searchbox", { name: "查找内容" });
    await expect(findInput).toBeFocused();
    await findInput.fill("移动端历史问题");

    const activeMatch = page.locator('[data-slot="message-row"][data-find-active="true"]');
    await expect(activeMatch).toContainText("移动端历史问题");
    await expect(activeMatch).toBeInViewport();
    await expect(page.locator('[data-slot="chat-find-results"]')).toHaveText("1 / 1");

    const findBarBounds = await page.locator('[data-slot="chat-find-bar"]').boundingBox();
    expect(findBarBounds).not.toBeNull();
    expect(findBarBounds!.x).toBeGreaterThanOrEqual(0);
    expect(findBarBounds!.x + findBarBounds!.width).toBeLessThanOrEqual(390);
  });
});
