// E2E: PTY 终端 scrollback 历史加载行为验证
// 前置条件: relay + proxy 在线，至少一个 PTY session 存在，H5 dev server 在 localhost:5175
// 运行: pnpm --filter feishu exec playwright test e2e/terminal-scrollback.spec.ts
import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:5175";

async function waitForSelector(page: import("@playwright/test").Page, selector: string, timeoutMs = 15000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

test("scroll to top loads history lines", async ({ page }) => {
  await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
  await page.evaluate(() => {
    localStorage.removeItem("cc_proxyId");
    localStorage.removeItem("cc_sessionId");
    localStorage.removeItem("cc_sessionMode");
  });
  // reload 而非 goto：Taro H5 SPA 的 goto 同 URL 只切 hash 路由，
  // 不重新挂载 App 组件，WebSocket 不会重新连接
  await page.reload();

  // 等 proxy 列表出现
  const hasProxy = await waitForSelector(page, ".proxy-item");
  test.skip(!hasProxy, "No online proxy available");
  await page.click(".proxy-item");

  // 等 session 列表出现
  const hasSession = await waitForSelector(page, ".sli-wrapper");
  test.skip(!hasSession, "No session available");

  // 找 PTY session
  const ptySession = await page.$('.sli-wrapper:has(.sli-mode-pty)');
  test.skip(!ptySession, "No PTY session available");
  await ptySession!.click();

  // 等终端 viewport 渲染
  const hasViewport = await waitForSelector(page, ".terminal-line");
  expect(hasViewport).toBe(true);

  const initialLineCount = await page.$$eval(".terminal-line", (els) => els.length);
  expect(initialLineCount).toBeGreaterThan(0);

  // 滚动到顶部触发 scrollback
  // terminal-viewport 用 addEventListener 绑定原生 scroll 事件，
  // 设置 scrollTop 并 dispatch scroll 事件即可触发
  await page.evaluate(() => {
    const vp = document.querySelector(".terminal-viewport");
    if (vp) {
      vp.scrollTop = vp.scrollHeight;
    }
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const vp = document.querySelector(".terminal-viewport");
    if (vp) {
      vp.scrollTop = 0;
      vp.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  });
  await page.waitForTimeout(5000);

  // 验证 scrollback 被触发：出现 oldest 标记或行数增加
  const hasOldest = await page.$(".scrollback-oldest");
  const newLineCount = await page.$$eval(".terminal-line", (els) => els.length);

  const scrollbackTriggered = hasOldest !== null || newLineCount > initialLineCount;
  expect(scrollbackTriggered).toBe(true);
});
