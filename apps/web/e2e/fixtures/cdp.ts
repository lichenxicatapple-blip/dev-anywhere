// L4 mobile spec 的 Playwright fixture: 通过 CDP 挂到 Android emu 的 Chrome 上.
// 入口前置: scripts/test/mobile.sh 已建 adb forward tcp:9222 -> chrome_devtools_remote.
import { chromium, type Browser, type Page } from "@playwright/test";
import { test as base } from "@playwright/test";

const CDP_ENDPOINT = process.env.MOBILE_CDP_ENDPOINT ?? "http://localhost:9222";
const VITE_BASE_URL = process.env.MOBILE_VITE_BASE_URL ?? "http://localhost:5174";

interface MobileWorkerFixtures {
  emuBrowser: Browser;
  emuPage: Page;
}

// emu 上 page.goto 偶发 ERR_ABORTED / Target closed (CDP-over-Android 的 navigation
// race 限制). 失败 sleep 后重试一次, 配合 worker scope 单 page 实测能把全套稳住.
async function safeGoto(page: Page, url: string): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

export const test = base.extend<Record<never, never>, MobileWorkerFixtures>({
  // 整个 worker 复用一个 browser 连接, 减少 CDP attach 抖动.
  emuBrowser: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
      await use(browser);
      // The Android Chrome instance is owned by scripts/test/mobile.sh. Closing the
      // CDP-connected Browser from Playwright can hang or tear down the device-side
      // DevTools socket after a timed-out test, which makes retries connect to a
      // dead endpoint. Let the worker process drop the websocket; the script
      // force-stops Chrome before each spec file.
    },
    { scope: "worker" },
  ],

  // emuPage 是 worker scope 共享同一个 page. Android Chrome over CDP 的三条限制
  // 决定了这种实现方式:
  // 1. Target.createBrowserContext 失败, 不能 newContext 隔离;
  // 2. page.close 在 emu 上不会从 chrome 删 tab (CDP 会标 page object closed,
  //    但 emu chrome 里的实际 tab 仍保留, 多次 newPage 会让 chrome 里 tab 单调累积);
  // 3. addInitScript 没有 unregister API, 跨 spec 共用 page 时多次 install 会让
  //    fake relay 的 init script 重复叠加.
  //
  // 跨 spec file 隔离: scripts/test/mobile.sh 每个 spec file 调用前 force-stop
  // chrome, 让该 spec file 拿到全新 chrome process. 同 spec file 内多个 test 共享
  // 这一个 page, 通过 spec 内的 setupPtyChat / installFakeRelay+reload 各自 reset.
  emuPage: [
    async ({ emuBrowser }, use) => {
      const contexts = emuBrowser.contexts();
      const context = contexts[0] ?? (await emuBrowser.newContext());
      const pages = context.pages();
      const page = pages[0] ?? (await context.newPage());
      await safeGoto(page, VITE_BASE_URL);
      await use(page);
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
export const mobileBaseUrl = VITE_BASE_URL;
