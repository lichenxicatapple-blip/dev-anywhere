import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { expectPtyTerminalMounted, readRawPtyInput, setupPtyChat } from "../pty-fixture";
import { dismissSoftKeyboard, tapWithAdb, waitForSoftKeyboard } from "./pty-soft-keyboard";

test("edits terminal dimensions above the Android numeric keyboard", async ({
  emuPage: page,
}, testInfo) => {
  test.setTimeout(60_000);
  await setupPtyChat(page, {
    sessionId: "mobile-terminal-dimensions",
    sessionKind: "terminal",
    provider: "claude",
    ptyOwner: "proxy-hosted",
    cols: 80,
    rows: 24,
    baseUrl: mobileBaseUrl,
  });
  await expectPtyTerminalMounted(page, { timeout: 30_000 });
  try {
    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    const menu = page.locator('[data-slot="chat-overflow-menu"]');
    const columns = page.getByRole("textbox", { name: "设置列数" });
    const rows = page.getByRole("textbox", { name: "设置行数" });
    await expect(columns).toBeVisible();
    const initialWidth = (await menu.boundingBox())!.width;
    await tapWithAdb(columns);
    await waitForSoftKeyboard(page);
    await expect(columns).toBeFocused();
    await expect(columns).toHaveAttribute("inputmode", "numeric");
    await expect
      .poll(() =>
        columns.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const viewport = window.visualViewport!;
          return (
            rect.top >= viewport.offsetTop && rect.bottom <= viewport.offsetTop + viewport.height
          );
        }),
      )
      .toBe(true);
    expect((await menu.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
    await page.screenshot({ path: testInfo.outputPath("terminal-size-numeric-keyboard.png") });

    const requests = () =>
      page.evaluate(() =>
        window.__ptySmoke.sent
          .map((raw) => JSON.parse(raw) as { type: string; cols: number; rows: number })
          .filter((message) => message.type === "terminal_resize_request")
          .map(({ cols, rows }) => ({ cols, rows })),
      );
    await columns.fill("160");
    await columns.press("Enter");
    await expect.poll(requests).toEqual([{ cols: 160, rows: 24 }]);
    await rows.fill("0");
    await rows.press("Enter");
    await expect(rows).toHaveAttribute("aria-invalid", "true");
    expect(await requests()).toHaveLength(1);
    await rows.fill("60");
    await rows.press("Enter");
    await expect.poll(requests).toEqual([
      { cols: 160, rows: 24 },
      { cols: 160, rows: 60 },
    ]);
    expect(await readRawPtyInput(page)).toBe("");
    await expect(menu).toBeVisible();
  } finally {
    await dismissSoftKeyboard(page);
  }
});
