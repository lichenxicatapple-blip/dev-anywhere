// 真 Android emu Chrome 上 JSON 输入栏 @ 触发的文件选择器 tap 流程: 弹起 picker,
// 触屏 tap entry 注入 @<path> token 到输入栏, 发送后 user_input 携带该 path.
// 与 L2 mobile-contract 的 picker visible 覆盖互补 (L2 没真触屏 tap entry).
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay, sentFakeRelayMessages } from "../helpers";

test.describe("L4 mobile / @ file picker tap-to-attach", () => {
  test.setTimeout(60_000);

  test("tap a file entry inserts @<path> token and send carries it", async ({ emuPage }) => {
    await installFakeRelay(emuPage);
    // test-sess: fakeRelay 默认无 pending approval (json-sess 自带, 会卡 send disable).
    await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
    await emuPage.reload();

    const input = emuPage.getByLabel("输入聊天消息");
    await expect(input).toBeVisible({ timeout: 30_000 });

    await input.click();
    await input.fill("@");
    const picker = emuPage.locator('[data-slot="file-path-picker"][data-mode="insert"]');
    await expect(picker).toBeVisible({ timeout: 15_000 });

    // 真触屏 tap 第一个 file entry (dir 类型 click 是进入子目录, file 类型才提交并关 picker).
    // fakeRelay file-tree 提供 'src/' (dir) + 'README.md' (file).
    const fileEntry = picker.locator('[data-slot="file-entry"][data-entry-type="file"]').first();
    await expect(fileEntry).toBeVisible();
    const entryText = (await fileEntry.innerText()).trim().split(/\s+/)[0];
    expect(entryText).toBeTruthy();
    await fileEntry.click();

    // picker 关闭 + input 内容包含 entry 名 (具体格式可能是 "@src" 或 "@<full path>",
    // 这里只 lock 包含关系).
    await expect(picker).toHaveCount(0);
    await expect.poll(() => input.inputValue()).toContain(entryText!);

    // 发送, 验证 user_input 经 fakeRelay 收到包含 path token 的文本.
    const send = emuPage.locator('[data-slot="send-button"][data-variant="send"]');
    await send.click();
    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(emuPage)).some((msg) => {
          if (msg.type !== "user_input") return false;
          const text = (msg.payload as { text?: string } | undefined)?.text ?? "";
          return text.includes(entryText!);
        }),
      )
      .toBe(true);
  });
});
