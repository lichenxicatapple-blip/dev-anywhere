// L4 mobile spec 的 Playwright fixture: 通过 CDP 挂到 Android emu 的 Chrome 上.
// 入口前置: scripts/test-mobile.sh 已建 adb forward tcp:9222 -> chrome_devtools_remote.
import { chromium, type Browser, type Page } from "@playwright/test";
import { test as base } from "@playwright/test";

const CDP_ENDPOINT = process.env.MOBILE_CDP_ENDPOINT ?? "http://localhost:9222";
const VITE_BASE_URL = process.env.MOBILE_VITE_BASE_URL ?? "http://localhost:5174";

interface MobileFixtures {
  emuBrowser: Browser;
  emuPage: Page;
}

export const test = base.extend<MobileFixtures>({
  // 整个 worker 复用一个 browser 连接, 减少 CDP attach 抖动.
  emuBrowser: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
      await use(browser);
      await browser.close();
    },
    { scope: "worker" },
  ],

  emuPage: async ({ emuBrowser }, use) => {
    const contexts = emuBrowser.contexts();
    const context = contexts[0] ?? (await emuBrowser.newContext());
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    await page.goto(VITE_BASE_URL);
    await use(page);
  },
});

export { expect } from "@playwright/test";
export const mobileBaseUrl = VITE_BASE_URL;
