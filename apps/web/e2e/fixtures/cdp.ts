// L4 mobile spec 的 Playwright fixture: 通过 CDP 挂到 Android emu 的 Chrome 上.
// 入口前置: scripts/test/mobile.sh 已建 adb forward tcp:9222 -> chrome_devtools_remote.
import { chromium, type Browser, type Page } from "@playwright/test";
import { test as base } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const CDP_ENDPOINT = process.env.MOBILE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const VITE_BASE_URL = process.env.MOBILE_VITE_BASE_URL ?? "http://127.0.0.1:5174";
const execFileAsync = promisify(execFile);
const MOBILE_NETWORK_ERROR =
  /(?:net::ERR_(?:EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|CONNECTION_REFUSED)|chrome-error:\/\/chromewebdata)/;

async function restoreAdbReverse(): Promise<void> {
  const serialArgs = process.env.ANDROID_SERIAL ? ["-s", process.env.ANDROID_SERIAL] : [];
  const vitePort = new URL(VITE_BASE_URL).port || "5174";
  const relayPort = process.env.TIER_MOBILE_RELAY_PORT ?? "6100";
  await execFileAsync("adb", [...serialArgs, "reverse", `tcp:${vitePort}`, `tcp:${vitePort}`]);
  await execFileAsync("adb", [...serialArgs, "reverse", `tcp:${relayPort}`, `tcp:${relayPort}`]);
}

function isMobileNetworkError(error: unknown): boolean {
  return MOBILE_NETWORK_ERROR.test(error instanceof Error ? error.message : String(error));
}

async function isChromeNetworkErrorPage(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      if (document.documentURI.startsWith("chrome-error://")) return true;
      if (document.querySelector("#main-frame-error, .interstitial-wrapper")) return true;
      const text = document.body?.innerText ?? "";
      return /(?:ERR_(?:EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|CONNECTION_REFUSED)|No internet connection)/i.test(
        text,
      );
    })
    .catch(() => page.url().startsWith("chrome-error://"));
}

async function waitForFailedNavigationToSettle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => {});
  await page.waitForTimeout(250);
}

async function navigateWithTransportRecovery<T>(
  page: Page,
  navigate: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await navigate(attempt);
      if (!(await isChromeNetworkErrorPage(page))) return result;
      lastError = new Error("Android Chrome loaded chrome-error://chromewebdata/");
    } catch (error) {
      if (!isMobileNetworkError(error)) throw error;
      lastError = error;
    }

    if (attempt === 2) throw lastError;
    await restoreAdbReverse();
    // Chrome may still be committing its native offline page when Playwright's
    // navigation rejects. Let that commit finish before starting the retry.
    await waitForFailedNavigationToSettle(page);
  }
  throw lastError;
}

function installNavigationTransportRecovery(page: Page): void {
  const originalGoto = page.goto.bind(page);
  const originalReload = page.reload.bind(page);

  page.goto = ((...args: Parameters<Page["goto"]>) =>
    navigateWithTransportRecovery(page, async () => {
      return originalGoto(...args);
    })) as Page["goto"];

  page.reload = ((...args: Parameters<Page["reload"]>) => {
    const targetUrl = page.url();
    const options = args[0];
    return navigateWithTransportRecovery(page, async (attempt) => {
      return attempt === 0 ? originalReload(...args) : originalGoto(targetUrl, options);
    });
  }) as Page["reload"];
}

interface MobileTestFixtures {
  emuPage: Page;
}

interface MobileWorkerFixtures {
  emuBrowser: Browser;
}

// emu 上 page.goto 偶发 ERR_ABORTED / Target closed (CDP-over-Android 的 navigation
// race 限制). 失败 sleep 后重试一次, 配合 worker scope 单 page 实测能把全套稳住.
async function safeGoto(page: Page, url: string): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForFunction(
        () => {
          const root = document.querySelector("#root");
          return root !== null && root.childElementCount > 0;
        },
        undefined,
        { timeout: 10_000 },
      );
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

export const test = base.extend<MobileTestFixtures, MobileWorkerFixtures>({
  // 整个 worker 复用一个 browser 连接, 减少 CDP attach 抖动.
  emuBrowser: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
      await use(browser);
      // The Android Chrome instance is owned by scripts/test/mobile.sh. Closing the
      // CDP-connected Browser from Playwright can hang or tear down the device-side
      // DevTools socket after a timed-out test, which makes retries connect to a
      // dead endpoint. Let the worker process drop the websocket; the script creates
      // and owns one CDP connection for the complete serial suite.
    },
    { scope: "worker" },
  ],

  // emuPage 每个 test 创建一个 page. Android Chrome over CDP 的三条限制
  // 决定了这种实现方式:
  // 1. Target.createBrowserContext 失败, 不能 newContext 隔离;
  // 2. page.close 在 emu 上不会从 chrome 删 tab (CDP 会标 page object closed,
  //    但 emu chrome 里的实际 tab 仍保留, 多次 newPage 会让 chrome 里 tab 单调累积);
  // 3. addInitScript 没有 unregister API, 跨 spec 共用 page 时多次 install 会让
  //    fake relay 的 init script 重复叠加.
  //
  // 整套发布门禁只建立一次 browser CDP connection；每个 test 的 newPage 提供独立
  // document 和 addInitScript registry。测试结束不调用 page.close，因为 Android
  // Chrome 不会真正删除该 tab，且异步 close 可能杀掉下一个 target；Chrome 进程在
  // 整套结束后统一回收。
  emuPage: [
    async ({ emuBrowser }, use) => {
      const contexts = emuBrowser.contexts();
      const context = contexts[0] ?? (await emuBrowser.newContext());
      const page = await context.newPage();
      installNavigationTransportRecovery(page);
      await safeGoto(page, VITE_BASE_URL);
      // Target replacement preserves this origin's storage. Clear it before each spec
      // installs its init scripts so a previous fake proxy/session selection cannot
      // redirect the next spec to stale offline state.
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await use(page);
    },
    // safeGoto has three bounded recovery attempts (20s navigation + 10s shell
    // readiness each). Do not let the global 30s test timeout cut the worker
    // fixture off halfway through its documented recovery budget.
    { scope: "test", timeout: 100_000 },
  ],
});

export { expect } from "@playwright/test";
export const mobileBaseUrl = VITE_BASE_URL;
