import type { Page } from "@playwright/test";

// 本地 Vite 默认端口 5173；CI 或外部 relay-served 部署可通过 WEB_BASE_URL 覆盖
export const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

// 清理 localStorage cc_* 命名空间并刷新页面，恢复到首次访问状态
export async function resetLocalState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("cc_"));
    keys.forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
}

// 读取 store 暴露在 window.__APP_STORE__ 的 proxy 列表，返回第一个 online proxyId
// 注：__APP_STORE__ 的 window 暴露由 Plan 10-01b 的 dev 钩子添加；当前 helper 若读不到返回 null
export async function getOnlineProxyId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __APP_STORE__?: {
        getState: () => { proxies: Array<{ proxyId: string; online: boolean }> };
      };
    };
    const proxies = w.__APP_STORE__?.getState().proxies ?? [];
    return proxies.find((p) => p.online)?.proxyId ?? null;
  });
}
