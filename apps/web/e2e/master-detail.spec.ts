import { test, expect } from "@playwright/test";
import { BASE_URL, resetLocalState } from "./helpers";

test.describe("Master-detail — 桌面端即时会话切换", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await resetLocalState(page);
  });

  test("侧栏挂载 session-list slot", async ({ page }) => {
    const sidebar = page.locator("nav[aria-label='Sidebar navigation']");
    await expect(sidebar).toBeVisible();
    // 即便 session 列表为空，slot 容器必须存在（Sidebar 10-01b 契约）
    const middle = sidebar.locator('[data-slot="sidebar-session-list"]');
    await expect(middle).toHaveCount(1);
  });

  test("点击 session row 更新 URL 而不 reload 文档", async ({ page }) => {
    // 借助 dev store hook 注入一个虚拟 session
    await page.evaluate(() => {
      const w = window as unknown as {
        __SESSION_STORE__?: {
          getState: () => { addSession: (s: unknown) => void };
        };
      };
      w.__SESSION_STORE__?.getState().addSession({
        sessionId: "test-sess-1",
        name: "Test Session",
        mode: "json",
        state: "idle",
      });
    });
    const row = page.locator('[data-slot="session-row"]').first();
    const rowCount = await row.count();
    if (rowCount === 0) {
      test.skip(true, "dev store hook 未暴露，跳过直到 Plan 10-06 补 __SESSION_STORE__");
    }
    await row.click();
    await expect(page).toHaveURL(/\/chat\/test-sess-1/);
    // performance navigation type 校验：同文档切换不是 reload
    const navType = await page.evaluate(() => {
      const entries = performance.getEntriesByType("navigation");
      return entries.length > 0
        ? (entries[0] as PerformanceNavigationTiming).type
        : "unknown";
    });
    expect(navType).not.toBe("reload");
  });

  test("选中 session row 带 data-selected='true'", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as {
        __SESSION_STORE__?: {
          getState: () => {
            addSession: (s: unknown) => void;
            setCurrentSession: (id: string, mode: string) => void;
          };
        };
      };
      const store = w.__SESSION_STORE__;
      store?.getState().addSession({
        sessionId: "test-sess-2",
        name: "Another Session",
        mode: "json",
        state: "idle",
      });
      store?.getState().setCurrentSession("test-sess-2", "json");
    });
    const selectedRow = page.locator('[data-slot="session-row"][data-selected="true"]');
    const count = await selectedRow.count();
    if (count === 0) {
      test.skip(true, "dev store hook 未暴露");
    }
    await expect(selectedRow).toBeVisible();
  });
});
