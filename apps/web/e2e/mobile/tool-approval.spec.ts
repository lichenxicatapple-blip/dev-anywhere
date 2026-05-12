// 真 Android emu Chrome 上工具审批卡片三按钮真触屏交互: 允许 / 拒绝 / 始终允许.
// L2 mobile-contract 已验证 touch-target 尺寸 + deny click, L4 真机补 allow / always-allow
// 路径 + 验证 fakeRelay 收到对应 tool_approve / tool_deny + scope 字段.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay, sentFakeRelayMessages } from "../helpers";

async function setupApprovalChat(page: import("@playwright/test").Page): Promise<void> {
  await installFakeRelay(page);
  // json-sess 在 fakeRelay 默认带 1 个 pending approval (Bash command "pnpm test").
  await page.goto(`${mobileBaseUrl}/#/chat/json-sess?mode=json`);
  await page.reload();
  const card = page.locator('[data-slot="tool-approval-card"][data-status="pending"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
}

test.describe("L4 mobile / tool approval card three-button tap", () => {
  test.setTimeout(60_000);

  test("tap '允许' emits tool_approve once", async ({ emuPage }) => {
    await setupApprovalChat(emuPage);
    const card = emuPage.locator('[data-slot="tool-approval-card"][data-status="pending"]');
    await card.getByRole("button", { name: "允许", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(emuPage)).filter((m) => m.type === "tool_approve").length,
      )
      .toBe(1);
  });

  test("tap '始终允许' emits tool_approve (scope=session 风格 - 此处 lock 行为, scope 字段由 web 自填)", async ({
    emuPage,
  }) => {
    await setupApprovalChat(emuPage);
    const card = emuPage.locator('[data-slot="tool-approval-card"][data-status="pending"]');
    await card.getByRole("button", { name: "始终允许", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(emuPage)).filter((m) => m.type === "tool_approve").length,
      )
      .toBe(1);
  });

  test("tap '拒绝' emits tool_deny", async ({ emuPage }) => {
    await setupApprovalChat(emuPage);
    const card = emuPage.locator('[data-slot="tool-approval-card"][data-status="pending"]');
    await card.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(emuPage)).filter((m) => m.type === "tool_deny").length,
      )
      .toBe(1);
  });
});
