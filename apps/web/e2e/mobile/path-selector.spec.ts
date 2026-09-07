import { expect, test } from "../fixtures/cdp";
import {
  installFakeRelay,
  openCreateAgentSessionDialog,
  selectFakeProxy,
  sentFakeRelayMessages,
} from "../helpers";
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
    await expect(cwdControl).toHaveText("~");
    await expect(cwdControl.locator("span[title]")).toHaveAttribute("title", "/home/dev");
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
    await expect(cliPathControl).toHaveText("~/.local/bin/README.md");
    await expect(cliPathControl.locator("span[title]")).toHaveAttribute(
      "title",
      "/home/dev/.local/bin/README.md",
    );
    const cliPathActions = sessionDialog.locator('[data-slot="agent-cli-path-actions"]');
    await expect(cliPathActions).toBeVisible();
    await cliPathActions.getByRole("button", { name: "取消" }).click();
    await expect(cliPathControl).toHaveText("~/.local/bin/claude");
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
    const currentPath = previewDialog.locator('[data-slot="file-path-picker-current-directory"]');
    await expect(currentPath).toHaveText("~/sample-app");
    await expect(currentPath).toHaveAttribute("title", "/home/dev/sample-app");
    await previewDialog.locator('[data-slot="select-current-directory"]').click();
    await expect(webPathControl).toHaveText("~/sample-app");
    await expect(webPathControl.locator("span[title]")).toHaveAttribute(
      "title",
      "/home/dev/sample-app/",
    );
    await expect(
      previewDialog.locator('input[type="hidden"][name="dev-anywhere-preview-static-path"]'),
    ).toHaveValue("/home/dev/sample-app/");
    await previewDialog.locator('[data-slot="create-web-preview-submit"]').click();
    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(page)).find(
          (message) => message.type === "preview_create_request",
        ),
      )
      .toMatchObject({
        source: { kind: "static", path: "/home/dev/sample-app/", entryPath: "index.html" },
      });
  });

  test("uses the remote Windows home without folding the selected directory", async ({
    emuPage: page,
  }) => {
    const homePath = "C:\\Users\\remote-dev";
    const directory = `${homePath}\\projects\\sample-app\\output`;
    await page.evaluate(
      ({ homePath, directory }) => {
        const socket = window.__devAnywhereE2E!.socket!;
        socket.emitJson({
          type: "proxy_info",
          homePath,
          agentCli: {
            claude: { available: true, command: `${homePath}\\bin\\claude.exe` },
            codex: { available: false },
            kimi: { available: false },
          },
        });
        socket.emitJson({
          type: "file_tree_push",
          groups: [
            { path: homePath, entries: [{ name: "projects", isDir: true }] },
            { path: `${homePath}\\projects`, entries: [{ name: "sample-app", isDir: true }] },
            {
              path: `${homePath}\\projects\\sample-app`,
              entries: [{ name: "output", isDir: true }],
            },
            { path: directory, entries: [] },
          ],
        });
      },
      { homePath, directory },
    );

    const dialog = await openCreateAgentSessionDialog(page);
    const cwdControl = dialog.getByLabel("工作目录");
    await expect(cwdControl).toHaveText("~");
    await expect(cwdControl.locator("span[title]")).toHaveAttribute("title", homePath);
    await expect(dialog.getByLabel("CLI 路径")).toHaveText("~\\bin\\claude.exe");
    await cwdControl.click();
    const currentPath = dialog.locator('[data-slot="file-path-picker-current-directory"]');
    await expect(currentPath).toHaveText("~");
    await expect(currentPath).toHaveAttribute("title", homePath);
    for (const name of ["projects", "sample-app", "output"]) {
      await dialog.locator(`[data-slot="file-entry"][data-entry-name="${name}"]`).click();
    }
    await expect(currentPath).toHaveText("~\\projects\\sample-app\\output");
    await expect(currentPath).toHaveAttribute("title", directory);
    await dialog.locator('[data-slot="select-current-directory"]').click();
    await expect(cwdControl).toHaveText("~\\projects\\sample-app\\output");
    await expect(cwdControl.locator("span[title]")).toHaveAttribute("title", `${directory}\\`);
    await expect(
      dialog.locator('input[type="hidden"][name="dev-anywhere-session-cwd"]'),
    ).toHaveValue(`${directory}\\`);
  });
});
