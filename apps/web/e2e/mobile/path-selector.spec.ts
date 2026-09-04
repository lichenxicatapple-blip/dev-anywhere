import { expect, test } from "../fixtures/cdp";
import { installFakeRelay, openCreateAgentSessionDialog, selectFakeProxy } from "../helpers";
import { installVisualViewportMock } from "../mobile-helpers";

test.describe("mobile remote path selection", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ emuPage }) => {
    await installVisualViewportMock(emuPage);
    await installFakeRelay(emuPage);
    // Both helpers above register init scripts. The shared Android page is already
    // open at the app origin, so changing only the hash would not install them.
    await emuPage.reload();
    await selectFakeProxy(emuPage);
  });

  test("uses file browsing without focusing path text fields", async ({ emuPage: page }) => {
    const sessionDialog = await openCreateAgentSessionDialog(page);
    const cwdControl = sessionDialog.getByLabel("工作目录");
    await expect(cwdControl).toHaveAttribute("data-path-control", "button");
    await expect(
      sessionDialog.locator('input[type="text"][name="dev-anywhere-session-cwd"]'),
    ).toHaveCount(0);

    const cliPathControl = sessionDialog.getByLabel("CLI 路径");
    await expect(cliPathControl).toHaveAttribute("data-path-control", "button");
    await expect(sessionDialog.getByRole("button", { name: "指定路径" })).toHaveCount(0);
    await expect(sessionDialog.locator('[data-slot="agent-cli-path-actions"]')).toHaveCount(0);
    await expect(sessionDialog.locator('[data-slot="remote-path-browser"]')).toHaveCount(0);
    await cliPathControl.click();
    await expect(sessionDialog.locator('[data-slot="remote-path-browser"]')).toBeVisible();
    await expect(
      sessionDialog.locator('input[type="text"][data-slot="agent-cli-path"]'),
    ).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ""))
      .not.toBe("INPUT");

    await sessionDialog.locator('[data-slot="file-entry"][data-entry-name="README.md"]').click();
    await expect(cliPathControl).toContainText("/home/dev/.local/bin/README.md");
    const cliPathActions = sessionDialog.locator('[data-slot="agent-cli-path-actions"]');
    await expect(cliPathActions).toBeVisible();
    await cliPathActions.getByRole("button", { name: "取消" }).click();
    await expect(cliPathControl).toContainText("/home/dev/.local/bin/claude");
    await expect(cliPathActions).toHaveCount(0);
    await sessionDialog
      .locator('[data-slot="dialog-footer"]')
      .getByRole("button", { name: "取消" })
      .click();

    await page
      .locator(
        '[data-slot="create-session-trigger"]:visible, [data-slot="create-session-mobile-trigger"]:visible',
      )
      .first()
      .click();
    await page
      .locator(
        '[data-slot="create-frontend-preview-item"]:visible, [data-slot="create-frontend-preview-sheet-item"]:visible',
      )
      .first()
      .click();
    await page.locator('[data-slot="frontend-preview-web"]').click();

    const previewDialog = page.locator('[data-slot="create-web-preview-dialog"]');
    await previewDialog.locator('[data-slot="web-preview-source-static"]').click();
    const webPathControl = previewDialog.getByLabel("网页位置");
    await expect(webPathControl).toHaveAttribute("data-path-control", "button");
    await expect(
      previewDialog.locator('input[type="text"][name="dev-anywhere-preview-static-path"]'),
    ).toHaveCount(0);

    await webPathControl.click();
    await previewDialog.locator('[data-slot="file-entry"][data-entry-name="sample-app"]').click();
    await previewDialog.locator('[data-slot="select-current-directory"]').click();
    await expect(webPathControl).toContainText("/home/dev/sample-app/");
  });
});
