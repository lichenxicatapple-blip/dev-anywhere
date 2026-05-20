// 真 Android emu Chrome 上 JSON 输入栏 @ 触发的文件选择器流程: 弹起 picker,
// 选择 entry 注入 @<path> token 到输入栏, 发送后 user_input 携带该 path.
// 与 L2 mobile-contract 的 picker visible 覆盖互补 (L2 没跑真 Android Chrome).
import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay, sentFakeRelayMessages } from "../helpers";
import type { Page, TestInfo } from "@playwright/test";

async function attachFileAttachDiagnostics(
  testInfo: TestInfo,
  page: Page,
  label: string,
): Promise<void> {
  const state = await page.evaluate(() => {
    const rectOf = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
      };
    };

    const input = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="输入聊天消息"]',
    );
    const picker = document.querySelector('[data-slot="file-path-picker"]');
    const send = document.querySelector('[data-slot="send-button"][data-variant="send"]');
    const entries = [...document.querySelectorAll('[data-slot="file-entry"]')].slice(0, 8);
    const active = document.activeElement;
    const visualViewport = window.visualViewport;

    return {
      url: window.location.href,
      readyState: document.readyState,
      activeElement: active
        ? {
            tagName: active.tagName,
            ariaLabel: active.getAttribute("aria-label"),
            dataSlot: active.getAttribute("data-slot"),
            text: active.textContent?.trim().slice(0, 120) ?? "",
            rect: rectOf(active),
          }
        : null,
      visualViewport: visualViewport
        ? {
            width: visualViewport.width,
            height: visualViewport.height,
            offsetTop: visualViewport.offsetTop,
            offsetLeft: visualViewport.offsetLeft,
            scale: visualViewport.scale,
          }
        : null,
      input: input ? { value: input.value, rect: rectOf(input) } : null,
      picker: picker
        ? {
            mode: picker.getAttribute("data-mode"),
            rect: rectOf(picker),
            text: picker.textContent?.trim().slice(0, 400) ?? "",
          }
        : null,
      send: send
        ? {
            disabled:
              send instanceof HTMLButtonElement
                ? send.disabled
                : send.getAttribute("aria-disabled") === "true",
            rect: rectOf(send),
          }
        : null,
      entries: entries.map((entry) => ({
        type: entry.getAttribute("data-entry-type"),
        text: entry.textContent?.trim().slice(0, 160) ?? "",
        rect: rectOf(entry),
      })),
      sentMessages:
        (window as Window & { __devAnywhereE2E?: { sent?: unknown[] } }).__devAnywhereE2E?.sent
          ?.length ?? null,
    };
  });

  await testInfo.attach(`${label}-state.json`, {
    body: JSON.stringify(state, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach(`${label}-page.png`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

test.describe("L4 mobile / @ file picker tap-to-attach", () => {
  test.setTimeout(90_000);

  test("select a file entry inserts @<path> token and send carries it", async ({
    emuPage,
  }, testInfo) => {
    try {
      await test.step("open json chat with fake relay", async () => {
        await installFakeRelay(emuPage);
        // test-sess: fakeRelay 默认无 pending approval (json-sess 自带, 会卡 send disable).
        await emuPage.goto(`${mobileBaseUrl}/#/chat/test-sess?mode=json`);
        await emuPage.reload();
      });

      const input = emuPage.getByLabel("输入聊天消息");
      await test.step("focus input and open @ picker", async () => {
        await expect(input).toBeVisible({ timeout: 30_000 });
        // Android Chrome CDP 复用现有 browser context, Playwright 无法给该 context
        // retro-fit hasTouch, Locator.tap 会直接报 "page does not support tap"。
        // 这里仍跑在真 Android Chrome 上, 用 click 驱动 DOM 交互并由 L2 覆盖触屏尺寸契约。
        await input.click({ timeout: 15_000 });
        await input.fill("@", { timeout: 15_000 });
      });

      const picker = emuPage.locator('[data-slot="file-path-picker"][data-mode="insert"]');
      await test.step("select first file entry from picker", async () => {
        await expect(picker).toBeVisible({ timeout: 15_000 });

        // 选择第一个 file entry (dir 类型是进入子目录, file 类型才提交并关 picker).
        // fakeRelay file-tree 提供 'src/' (dir) + 'README.md' (file).
        const fileEntry = picker
          .locator('[data-slot="file-entry"][data-entry-type="file"]')
          .first();
        await expect(fileEntry).toBeVisible({ timeout: 15_000 });
        const entryText = (await fileEntry.innerText()).trim().split(/\s+/)[0];
        expect(entryText).toBeTruthy();
        await fileEntry.click({ timeout: 15_000 });

        // picker 关闭 + input 内容包含 entry 名 (具体格式可能是 "@src" 或 "@<full path>",
        // 这里只 lock 包含关系).
        await expect(picker).toHaveCount(0, { timeout: 15_000 });
        await expect.poll(() => input.inputValue(), { timeout: 15_000 }).toContain(entryText!);
      });

      await test.step("send message and verify relay payload", async () => {
        const entryText = (await input.inputValue()).replace(/^@/, "").trim().split(/\s+/)[0];
        expect(entryText).toBeTruthy();

        // 发送, 验证 user_input 经 fakeRelay 收到包含 path token 的文本.
        const send = emuPage.locator('[data-slot="send-button"][data-variant="send"]');
        await expect(send).toBeEnabled({ timeout: 15_000 });
        await send.click({ timeout: 15_000 });
        await expect
          .poll(
            async () =>
              (await sentFakeRelayMessages(emuPage)).some((msg) => {
                if (msg.type !== "user_input") return false;
                const text = (msg.payload as { text?: string } | undefined)?.text ?? "";
                return text.includes(entryText);
              }),
            { timeout: 15_000 },
          )
          .toBe(true);
      });
    } catch (error) {
      await attachFileAttachDiagnostics(testInfo, emuPage, "file-attach-failure");
      throw error;
    }
  });
});
