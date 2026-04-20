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
