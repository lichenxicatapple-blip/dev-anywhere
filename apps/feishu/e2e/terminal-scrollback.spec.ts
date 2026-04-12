// E2E: PTY 终端 scrollback 历史加载行为验证
// 前置条件: relay + proxy 在线，H5 build 已完成并在 localhost:5175 上 serve
// 运行: pnpm --filter feishu exec playwright test
import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:5175";

// Enable after Task 2 implements scrollback -- 需要完整集成环境
test.skip("scroll to top loads history lines", async ({ page }) => {
  // 清理本地状态
  await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
  await page.evaluate(() => {
    localStorage.removeItem("cc_proxyId");
    localStorage.removeItem("cc_sessionId");
  });
  await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
  await page.waitForTimeout(3000);

  // 选择 proxy
  const proxyItem = await page.$(".proxy-item");
  test.skip(!proxyItem, "No online proxy available");
  await proxyItem!.click();
  await page.waitForTimeout(2000);

  // 选择 PTY session
  const sessionItem = await page.$(".sli-wrapper");
  test.skip(!sessionItem, "No PTY session available");
  await sessionItem!.click();
  await page.waitForTimeout(2000);

  // 确认 terminal-viewport 存在且有行
  const viewport = await page.$(".terminal-viewport");
  expect(viewport).not.toBeNull();

  const initialLineCount = await page.$$eval(".terminal-line", (els) => els.length);
  expect(initialLineCount).toBeGreaterThan(0);

  // 滚动到顶部
  await page.evaluate(() => {
    const vp = document.querySelector(".terminal-viewport");
    if (vp) vp.scrollTop = 0;
  });
  await page.waitForTimeout(2000);

  // 检查是否有 loading indicator 或额外行出现
  const hasLoading = await page.$(".scrollback-loading");
  const hasOldest = await page.$(".scrollback-oldest");
  const newLineCount = await page.$$eval(".terminal-line", (els) => els.length);

  // 至少有一个条件满足：正在加载、已到最旧、或有新行
  const scrollbackTriggered = hasLoading !== null || hasOldest !== null || newLineCount > initialLineCount;
  expect(scrollbackTriggered).toBe(true);
});
