// E2E: 冷启动导航行为验证
// 前置条件: relay + proxy 在线，H5 build 已完成并在 localhost:5175 上 serve
// 运行: pnpm --filter feishu exec playwright test
import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:5175";

// 点击在线 proxy 完成绑定，等待导航到 session-list 后从 localStorage 读取 proxyId
async function getOnlineProxyId(page: import("@playwright/test").Page): Promise<string | null> {
  // 先清掉旧状态再加载页面
  await page.goto(`${BASE_URL}/#/pages/proxy-select/index`);
  await page.evaluate(() => {
    localStorage.removeItem("cc_proxyId");
    localStorage.removeItem("cc_sessionId");
    localStorage.removeItem("cc_sessionMode");
  });
  await page.reload();
  try {
    await page.waitForSelector(".proxy-item", { timeout: 8000 });
  } catch {
    console.log("[e2e] .proxy-item not found after 8s wait");
    return null;
  }
  const hasProxy = await page.$(".proxy-item");
  if (!hasProxy) return null;

  // click 触发 ensureBinding（async），成功后写 localStorage 并导航到 session-list
  await hasProxy.click();
  try {
    await page.waitForURL(/session-list/, { timeout: 5000 });
  } catch {
    const url = page.url();
    const ls = await page.evaluate(() => localStorage.getItem("cc_proxyId"));
    console.log(`[e2e] navigation timeout. URL=${url}, cc_proxyId=${ls}`);
    return null;
  }

  const proxyId = await page.evaluate(() => {
    const raw = localStorage.getItem("cc_proxyId");
    return raw ? JSON.parse(raw).data : null;
  });
  console.log(`[e2e] getOnlineProxyId resolved: ${proxyId}`);

  // 回到 proxy-select 准备后续测试
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
        localStorage.setItem("cc_sessionMode", JSON.stringify({ data: "pty" }));
      },
      { pid: proxyId, sid: "test-session-123" },
    );
    // reload 触发 SPA 完整重新初始化（goto 同 URL 不会重初始化）
    await page.reload();
    try {
      await page.waitForURL(/chat/, { timeout: 8000 });
    } catch {
      // binding 可能失败
    }

    expect(page.url()).toContain("/pages/chat/index");
  });

  test("saved proxyId but no sessionId + proxy online -> jump to session-list", async ({ page }) => {
    const proxyId = await getOnlineProxyId(page);
    test.skip(!proxyId, "No online proxy available");

    await page.evaluate((pid) => {
      localStorage.setItem("cc_proxyId", JSON.stringify({ data: pid }));
      localStorage.removeItem("cc_sessionId");
    }, proxyId);
    await page.reload();
    try {
      await page.waitForURL(/session-list/, { timeout: 8000 });
    } catch {
      // binding 可能失败
    }

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
