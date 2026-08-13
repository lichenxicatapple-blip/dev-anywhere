// L4 mobile spec 的 Playwright fixture: 通过 CDP 挂到 Android emu 的 Chrome 上.
// 入口前置: scripts/test/mobile.sh 已建 adb forward tcp:9222 -> chrome_devtools_remote.
import { chromium, type Browser, type Disposable, type Page } from "@playwright/test";
import { test as base } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const CDP_ENDPOINT = process.env.MOBILE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const VITE_BASE_URL = process.env.MOBILE_VITE_BASE_URL ?? "http://127.0.0.1:5174";
const execFileAsync = promisify(execFile);
const MOBILE_NETWORK_ERROR =
  /(?:net::ERR_(?:EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|CONNECTION_REFUSED)|chrome-error:\/\/chromewebdata)/;
let testDocumentRevision = 0;

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
  emuWorkerPage: Page;
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

function trackInitScripts(page: Page): () => Promise<void> {
  const originalAddInitScript = page.addInitScript.bind(page);
  const disposables: Disposable[] = [];
  page.addInitScript = (async (...args: unknown[]) => {
    const disposable = (await Reflect.apply(originalAddInitScript, page, args)) as Disposable;
    disposables.push(disposable);
    return disposable;
  }) as Page["addInitScript"];

  return async () => {
    page.addInitScript = originalAddInitScript;
    for (const disposable of disposables.reverse()) {
      await disposable.dispose();
    }
  };
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

  // Chrome is launched with one page target by scripts/test/mobile.sh. Keep that
  // exact target for the whole suite: Android Chrome can race target deletion with
  // the next Target.createTarget even when DevTools reports the old target gone.
  emuWorkerPage: [
    async ({ emuBrowser }, use) => {
      const context = emuBrowser.contexts()[0];
      const page = context?.pages()[0];
      if (!page) throw new Error("Android Chrome did not expose its startup page target");
      installNavigationTransportRecovery(page);
      await use(page);
    },
    { scope: "worker" },
  ],

  // Android Chrome over CDP 的限制决定了整套测试复用一个 target:
  // 1. Target.createBrowserContext 失败, 不能 newContext 隔离;
  // 2. page.close 在 emu 上不会从 chrome 删 tab (CDP 会标 page object closed,
  //    但 emu chrome 里的实际 tab 仍保留);
  // 3. 创建/关闭相邻 target 会发生误杀下一 target 的设备端竞态.
  //
  // 每条测试仍有独立的 init-script 与 route 生命周期：init script 直接经 CDP
  // 注册并按 identifier 移除，route 在 teardown 清空。页面存储也在 setup 清空。
  emuPage: [
    async ({ emuWorkerPage: page }, use) => {
      const removeInitScripts = trackInitScripts(page);
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      const cleanDocumentUrl = new URL(VITE_BASE_URL);
      cleanDocumentUrl.searchParams.set("__mobile_test", String(++testDocumentRevision));
      await safeGoto(page, cleanDocumentUrl.href);
      await use(page);
      await removeInitScripts();
      await page.unrouteAll({ behavior: "wait" });
    },
    // safeGoto has three bounded recovery attempts (20s navigation + 10s shell
    // readiness each). Do not let the global 30s test timeout cut the worker
    // fixture off halfway through its documented recovery budget.
    { scope: "test", timeout: 100_000 },
  ],
});

export { expect } from "@playwright/test";
export const mobileBaseUrl = VITE_BASE_URL;
