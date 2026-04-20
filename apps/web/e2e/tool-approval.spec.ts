import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("ToolApprovalCard — keyboard shortcuts", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/ta-sess?mode=json`);
    await resetLocalState(page);
  });

  test("card shows three buttons with exact copy when approval seeded", async ({ page }) => {
    // 依赖 window.__CHAT_STORE__ dev hook 暴露 store (当前未暴露, 测试自动 skip).
    // Plan 10-04b 接入 InputBar 前会扩展 hook, 届时本测试转为硬性断言.
    await page.goto(`${BASE_URL}/#/chat/ta-sess?mode=json`);
    const hookAvailable = await page.evaluate(() => {
      const w = window as unknown as {
        __CHAT_STORE__?: { getState: () => { addApprovalRequest: (r: unknown) => void } };
      };
      return Boolean(w.__CHAT_STORE__);
    });
    if (!hookAvailable) {
      test.skip(true, "__CHAT_STORE__ dev hook not available; skip until 10-04b adds it");
    }
    await page.evaluate(() => {
      const w = window as unknown as {
        __CHAT_STORE__: { getState: () => { addApprovalRequest: (r: unknown) => void } };
      };
      w.__CHAT_STORE__.getState().addApprovalRequest({
        requestId: "r1",
        toolName: "Bash",
        input: { command: "ls" },
        status: "pending",
      });
    });
    const card = page.locator('[data-slot="tool-approval-card"]').first();
    await expect(card.getByRole("button", { name: "允许" })).toBeVisible();
    await expect(card.getByRole("button", { name: "拒绝" })).toBeVisible();
    await expect(card.getByRole("button", { name: "总是允许此工具" })).toBeVisible();
  });
});
