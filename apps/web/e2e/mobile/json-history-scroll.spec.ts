// 真 Android emu 上 JSON 模式 streaming 不抢回底的语义钉死.
// L2 mobile-contract 已测 history 分页请求结构 + virtual height 稳, L4 补真机上
// "用户在翻历史 → streaming 进 → 视图不被强制拉到底" 这条 isAtBottom sticky 行为
// (PC follow-output 同语义, mobile 可能因虚拟列表 reflow 时机不同而退化).
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay } from "../helpers";

test.describe("L4 mobile / JSON streaming respects user reading position", () => {
  test.setTimeout(60_000);

  test("streaming new message does not auto-follow when user is scrolled up", async ({
    emuPage,
  }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/chat/fo-sess?mode=json`);
    await emuPage.reload();
    // 先等 input-bar 出现 (chat view mount 完毕). 此时 message-list 还可能因为
    // 0 message 没渲染容器, 灌 message 后再断言.
    await expect(emuPage.getByLabel("输入聊天消息")).toBeVisible({ timeout: 30_000 });

    // 灌 70 条历史让 list 可滚.
    await emuPage.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("__ccTest 未安装");
      const sid = "fo-sess";
      for (let i = 0; i < 70; i += 1) {
        hooks.chat.addUserMessage(sid, {
          id: `mobile-hist-u-${i}`,
          role: "user",
          text: `历史问题 ${i}`,
          isPartial: false,
          timestamp: Date.now() + i,
          toolCalls: [],
        });
        hooks.chat.appendAssistantText(sid, `历史回复 ${i}`);
        hooks.chat.markTurnComplete(sid);
      }
    });

    const list = emuPage.locator('[data-slot="message-list"]');
    await expect(list).toBeVisible();

    // 滚到中部模拟用户翻历史; 等 isAtBottom 状态稳定为 false (back-to-bottom 出现).
    await list.evaluate((node) => {
      const el = node as HTMLElement;
      el.scrollTop = Math.max(0, el.scrollHeight / 2);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const backToBottom = emuPage.locator('[data-slot="back-to-bottom"]');
    await expect(backToBottom).toHaveAttribute("aria-hidden", "false", { timeout: 10_000 });

    // 流式追加新内容. 用户在翻历史, auto-follow sticky 不该把 isAtBottom 翻回 true.
    await emuPage.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("__ccTest 未安装");
      hooks.chat.appendAssistantText("fo-sess", "\nstreaming new while user reading history\n");
      hooks.chat.markTurnComplete("fo-sess");
    });
    // 新消息出现 (有新消息 indicator), back-to-bottom 仍 aria-hidden=false (没被抢回底).
    await expect(emuPage.locator('[aria-label="有新消息"]')).toBeVisible();
    await expect(backToBottom).toHaveAttribute("aria-hidden", "false");
  });
});
