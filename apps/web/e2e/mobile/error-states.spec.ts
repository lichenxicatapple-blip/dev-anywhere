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

    await emuPage.locator('button:has-text("新建会话"):visible').last().click();
    const dialog = emuPage.locator('[data-slot="create-session-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // 输入一个 fakeRelay directories 集合外的路径 → PATH_NOT_FOUND error.
    await emuPage.getByLabel("工作目录").fill("/this/path/does/not/exist");
    // 关 file picker (focus 工作目录会自动弹).
    await emuPage.getByRole("heading", { name: "新建会话" }).click();
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

    await emuPage.locator('button:has-text("新建会话"):visible').last().click();
    const dialog = emuPage.locator('[data-slot="create-session-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // 触发 agent CLI 自定义路径输入; 灌一条很长的伪路径, 验证 dialog 不水平溢出.
    // emu Chrome 默认显示底部 chrome 工具栏, visual viewport 高度 (~428px) 远小于
    // layout viewport (789px), dialog 底部按钮在 layout viewport 内 (button.top≈631) 但
    // 落在 visual viewport 之外。playwright click 用 visual viewport 判定 actionability,
    // 即便 force: true 也拒绝在 visual viewport 之外的 element rect 上 dispatch click。
    // 改用 evaluate 调 native click(): 跟 user tap 等效, 不依赖 viewport intersect, 把
    // dialog UX 验证 (横向溢出) 跟 emu Chrome chrome bar 占空间这层无关问题剥离。
    const cliPathCard = dialog.locator('[data-slot="agent-cli-path-card"]');
    const cliPathButton = cliPathCard.getByRole("button", { name: "指定路径" });
    await cliPathButton.evaluate((btn) => (btn as HTMLButtonElement).click());
    const cliPathInput = cliPathCard.locator('input[list^="agent-cli-path-"]');
    await expect(cliPathInput).toBeVisible();
    await cliPathInput.fill(
      "/very/very/very/long/agent/cli/path/that/might/break/mobile/dialog/layout/if/clipped",
    );
    await expectNoHorizontalDocumentOverflow(emuPage);
    await expect(dialog).toBeVisible();
  });
});
