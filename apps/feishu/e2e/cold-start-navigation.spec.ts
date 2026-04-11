// E2E: 冷启动导航行为验证
// 前置条件: relay + proxy 在线，H5 build 已完成并在 localhost:5175 上 serve
// 运行: pnpm --filter feishu exec playwright test
import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:5175";

// 等待 proxy 列表加载，从 relay 响应中拦截 proxyId（不触发页面跳转）
async function getOnlineProxyId(page: import("@playwright/test").Page): Promise<string | null> {
  // 先清掉旧状态，确保不会触发冷启动跳转
  await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
  await page.evaluate(() => {
    localStorage.removeItem("cc_proxyId");
    localStorage.removeItem("cc_sessionId");
  });
  // 重新加载干净的 proxy-select 页面
  await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
  await page.waitForTimeout(3000);

  // 检查是否有 proxy 显示，然后通过 DOM 拦截 click 事件获取 proxyId
  // 用 evaluate 模拟点击并立即读取写入的 proxyId，再阻止导航
  const proxyId = await page.evaluate(() => {
    const item = document.querySelector(".proxy-item");
    if (!item) return null;
    // 直接 click 会触发 navigateTo，改为读取 proxy 列表数据
    // proxy 列表在 Taro state 里，但我们可以 click 后立即读 localStorage
    (item as HTMLElement).click();
    const raw = localStorage.getItem("cc_proxyId");
    return raw ? JSON.parse(raw).data : null;
  });
  // click 可能触发了导航，回到 proxy-select
  await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
  await page.waitForTimeout(500);
  return proxyId;
}

test.describe("cold start navigation", () => {
  test("no saved state -> stay on proxy-select", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
    await page.evaluate(() => {
      localStorage.removeItem("cc_proxyId");
      localStorage.removeItem("cc_sessionId");
    });
    await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
    await page.waitForTimeout(3000);

    expect(page.url()).toContain("/pages/proxy-select/index");
  });

  test("saved proxyId + sessionId + proxy online -> jump to chat", async ({ page }) => {
    const proxyId = await getOnlineProxyId(page);
    test.skip(!proxyId, "No online proxy available");

    await page.evaluate(
      ({ pid, sid }) => {
        localStorage.setItem("cc_proxyId", JSON.stringify({ data: pid }));
        localStorage.setItem("cc_sessionId", JSON.stringify({ data: sid }));
      },
      { pid: proxyId, sid: "test-session-123" },
    );
    await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
    await page.waitForTimeout(3000);

    expect(page.url()).toContain("/pages/chat/index");
  });

  test("saved proxyId but no sessionId + proxy online -> jump to session-list", async ({ page }) => {
    const proxyId = await getOnlineProxyId(page);
    test.skip(!proxyId, "No online proxy available");

    await page.evaluate((pid) => {
      localStorage.setItem("cc_proxyId", JSON.stringify({ data: pid }));
      localStorage.removeItem("cc_sessionId");
    }, proxyId);
    await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
    await page.waitForTimeout(3000);

    expect(page.url()).toContain("/pages/session-list/index");
  });

  test("saved proxyId but proxy offline -> stay on proxy-select", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
    await page.evaluate(() => {
      localStorage.setItem("cc_proxyId", JSON.stringify({ data: "nonexistent-proxy-id" }));
      localStorage.removeItem("cc_sessionId");
    });
    await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
    await page.waitForTimeout(3000);

    expect(page.url()).toContain("/pages/proxy-select/index");
  });
});

test.describe("visual consistency", () => {
  test("proxy-select and session-list have aligned section headers", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
    await page.waitForTimeout(2000);

    const proxyGap = await page.evaluate(() => {
      const title = document.querySelector(".proxy-section-title");
      const item = document.querySelector(".proxy-item");
      if (!title || !item) return null;
      return {
        gap: item.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
        display: getComputedStyle(title).display,
      };
    });

    // 点击 proxy 进入 session-list
    const proxyItem = await page.$(".proxy-item");
    if (proxyItem) await proxyItem.click();
    await page.waitForTimeout(2000);

    const sessionGap = await page.evaluate(() => {
      const header = document.querySelector(".session-section-header");
      const wrapper = document.querySelector(".sli-wrapper");
      if (!header || !wrapper) return null;
      return {
        gap: wrapper.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        display: getComputedStyle(header).display,
      };
    });

    test.skip(!proxyGap || !sessionGap, "Elements not found, proxy or sessions missing");

    expect(proxyGap!.display).toBe("block");
    expect(sessionGap!.display).toBe("block");
    expect(Math.abs(proxyGap!.gap - sessionGap!.gap)).toBeLessThan(0.5);
  });
});
