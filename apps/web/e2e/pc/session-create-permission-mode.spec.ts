import { expect, test, type Locator, type Page } from "@playwright/test";
import { installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "../helpers";

async function openCreateDialog(page: Page) {
  await page.locator('button:has-text("新建会话"):visible').last().click();
  await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
  return page.getByRole("dialog", { name: "新建会话" });
}

type SessionCreateCase = {
  name: string;
  mode: "json" | "pty";
  provider: "claude" | "codex";
  permissionLabel: string;
  permissionMode: string;
};

async function choosePermissionMode(page: Page, dialog: Locator, label: string) {
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: label }).click();
}

async function expectSessionCreate(page: Page, expected: SessionCreateCase) {
  await expect
    .poll(async () =>
      (await sentFakeRelayMessages(page)).some(
        (msg) =>
          msg.type === "session_create" &&
          msg.mode === expected.mode &&
          msg.provider === expected.provider &&
          msg.permissionMode === expected.permissionMode,
      ),
    )
    .toBe(true);
}

async function createSessionWithPermissionMode(page: Page, testCase: SessionCreateCase) {
  const dialog = await openCreateDialog(page);
  if (testCase.mode === "json") {
    await page
      .getByLabel("交互方式")
      .getByRole("button", { name: /聊天模式/ })
      .click();
  }
  if (testCase.provider === "codex") {
    await page.getByLabel("Agent CLI").getByRole("button", { name: /Codex/ }).click();
  }
  await page.getByLabel("工作目录").fill("/home/dev/projects/sample-app");
  await choosePermissionMode(page, dialog, testCase.permissionLabel);
  await dialog.getByRole("button", { name: "创建" }).click();
  await expectSessionCreate(page, testCase);
}

test.describe("session create permission mode", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
  });

  const claudePermissionModes = [
    ["严格审批", "default"],
    ["自动判定", "auto"],
    ["自动接受编辑", "acceptEdits"],
    ["只读规划", "plan"],
    ["跳过全部审批", "bypassPermissions"],
  ] as const;

  for (const mode of ["json", "pty"] as const) {
    for (const [permissionLabel, permissionMode] of claudePermissionModes) {
      test(`sends Claude ${mode} ${permissionLabel} permission mode in session_create`, async ({
        page,
      }) => {
        await createSessionWithPermissionMode(page, {
          name: `Claude ${mode} ${permissionLabel}`,
          mode,
          provider: "claude",
          permissionLabel,
          permissionMode,
        });
      });
    }
  }

  const codexPermissionModes = [
    ["严格审批", "default"],
    ["自动判定", "auto"],
    ["跳过全部审批", "bypassPermissions"],
  ] as const;

  for (const mode of ["json", "pty"] as const) {
    for (const [permissionLabel, permissionMode] of codexPermissionModes) {
      test(`sends Codex ${mode} ${permissionLabel} permission mode in session_create`, async ({
        page,
      }) => {
        await createSessionWithPermissionMode(page, {
          name: `Codex ${mode} ${permissionLabel}`,
          mode,
          provider: "codex",
          permissionLabel,
          permissionMode,
        });
      });
    }
  }
});
