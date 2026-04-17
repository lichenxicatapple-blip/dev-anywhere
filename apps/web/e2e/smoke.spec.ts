import { test, expect } from "@playwright/test";
import { BASE_URL } from "./helpers";

// Wave 0 baseline：SPA 能加载并渲染 body，后续 plan 会替换为真实验证
test("web app boots", async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page.locator("body")).toBeVisible();
});
