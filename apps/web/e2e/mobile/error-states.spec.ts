// 异常路径 UI 在移动端的 e2e: relay 不可用 / 工作目录不存在 / 长路径不溢出.
// L2 mobile-contract 已测 layout 契约 (布局 / touch-target / 视口溢出),
// L4 真机补 异常态下 UI 是否仍 touch-safe + 文案可见.
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "../helpers";
import { expectNoHorizontalDocumentOverflow } from "../mobile-helpers";

test.describe("L4 mobile / error UI states", () => {
  test.setTimeout(60_000);

  test("session_create with non-existent cwd shows inline error and stays in dialog", async ({
    emuPage,
  }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/`);
    await emuPage.reload();
    await selectFakeProxy(emuPage);

    await emuPage.locator('[data-slot="create-session-mobile-trigger"]:visible').click();
    await emuPage.locator('[data-slot="create-agent-session-sheet-item"]').click();
    const dialog = emuPage.locator('[data-slot="create-session-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // 选择一个 fakeRelay 会列出、但不在其可创建会话目录集合中的路径。
    const cwdControl = dialog.getByLabel("工作目录");
    await cwdControl.click();
    await dialog.locator('[data-slot="file-entry"][data-entry-name="sample-app"]').click();
    await dialog.locator('[data-slot="select-current-directory"]').click();
    await expect(cwdControl).toContainText("/home/dev/sample-app/");
    await dialog.getByRole("button", { name: "创建" }).click();

    // 错误文案出现; dialog 不关闭, 用户仍能编辑.
    await expect(dialog.getByText(/工作目录不存在|PATH_NOT_FOUND|不可访问/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog).toBeVisible();
    await expectNoHorizontalDocumentOverflow(emuPage);

    // session_create_response 应有 errorCode (fakeRelay mock).
    const responses = (await sentFakeRelayMessages(emuPage)).filter(
      (m) => m.type === "session_create",
    );
    expect(responses.length).toBeGreaterThanOrEqual(1);
  });

  test("create-session dialog stays touch-safe on long agent CLI path input", async ({
    emuPage,
  }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/`);
    await emuPage.reload();
    await selectFakeProxy(emuPage);

    await emuPage.locator('[data-slot="create-session-mobile-trigger"]:visible').click();
    await emuPage.locator('[data-slot="create-agent-session-sheet-item"]').click();
    const dialog = emuPage.locator('[data-slot="create-session-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // 手机端常显路径按钮而非文本框；逐层进入目录后选中文件，构造长路径草稿。
    const cliPathCard = dialog.locator('[data-slot="agent-cli-path-card"]');
    const cliPathControl = cliPathCard.getByLabel("CLI 路径");
    await expect(cliPathControl).toHaveAttribute("data-path-control", "button");
    await expect(cliPathCard.getByRole("button", { name: "指定路径" })).toHaveCount(0);
    await expect(cliPathCard.locator('[data-slot="agent-cli-path-actions"]')).toHaveCount(0);
    await cliPathControl.click();
    for (let depth = 0; depth < 8; depth += 1) {
      await cliPathCard.locator('[data-slot="file-entry"][data-entry-name="src"]').click();
    }
    await cliPathCard.locator('[data-slot="file-entry"][data-entry-name="README.md"]').click();
    await expect(cliPathControl).toContainText(
      "/home/dev/.local/bin/src/src/src/src/src/src/src/src/README.md",
    );
    await expect(cliPathCard.locator('[data-slot="agent-cli-path-actions"]')).toBeVisible();
    await expectNoHorizontalDocumentOverflow(emuPage);
    await expect(dialog).toBeVisible();
  });
});
