import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import {
  backToBottom,
  backToBottomNewIndicator,
  ptyTerminal,
  sendPtyOutput,
} from "../pty-scroll-helpers";

const SESSION_ID = "pty-review-snapshot";

test.use({ viewport: { width: 900, height: 640 } });

async function directRenderedRowsText(page: import("@playwright/test").Page): Promise<string> {
  return page.locator('[data-slot="pty-host"] .xterm-screen').evaluate((screen) => {
    const rows = Array.from(screen.children).find(
      (child) =>
        child instanceof HTMLElement &&
        child.classList.contains("xterm-rows") &&
        child.dataset.slot !== "pty-review-snapshot",
    );
    return rows?.textContent ?? "";
  });
}

test("keeps a coherent frame while live rows update across the scrollback boundary", async ({
  page,
}) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    cols: 80,
    rows: 24,
    withVisualViewportMock: true,
  });
  await expectPtyTerminalMounted(page);

  await page.evaluate(() => window.__ptySmoke.resize(80, 24));
  await page.waitForTimeout(100);
  await sendPtyOutput(
    page,
    Array.from(
      { length: 48 },
      (_, index) => `SCROLLBACK HISTORY ${String(index + 1).padStart(2, "0")}\r\n`,
    ).join(""),
  );
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
    .toContain("SCROLLBACK HISTORY 48");

  await sendPtyOutput(
    page,
    `\u001b7${Array.from(
      { length: 24 },
      (_, index) =>
        `\u001b[${index + 1};1HCURRENT SCREEN ${String(index + 1).padStart(2, "0")}${" ".repeat(45)}`,
    ).join("")}\u001b8`,
  );

  const box = await ptyTerminal(page).boundingBox();
  if (!box) throw new Error("PTY terminal is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -180);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toBeVisible();
  await expect(snapshot).toContainText("SCROLLBACK HISTORY");
  await expect(snapshot).toContainText("CURRENT SCREEN");
  const frozenText = await snapshot.textContent();

  await sendPtyOutput(
    page,
    "\u001b7\u001b[8;1HLIVE UPDATE tick 01                              \u001b8",
  );

  await expect.poll(() => directRenderedRowsText(page)).toContain("LIVE UPDATE tick 01");
  await expect(snapshot).toHaveText(frozenText ?? "");
  await expect(snapshot).not.toContainText("LIVE UPDATE tick 01");
  await expect(backToBottomNewIndicator(page)).toBeVisible();
  await expect(backToBottom(page)).toHaveAttribute("aria-label", "回到最新");

  await page.mouse.wheel(0, 40);
  await expect(snapshot).toContainText("LIVE UPDATE tick 01");

  await page.mouse.wheel(0, 10_000);
  await expect(snapshot).toHaveCount(0);
  await expect(backToBottom(page)).toHaveJSProperty("inert", true);
});

test("keeps the reviewed frame frozen while live output appends new lines", async ({ page }) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    cols: 80,
    rows: 24,
    withVisualViewportMock: true,
  });
  await expectPtyTerminalMounted(page);

  await page.evaluate(() => window.__ptySmoke.resize(80, 24));
  await page.waitForTimeout(100);
  await sendPtyOutput(
    page,
    Array.from(
      { length: 5_200 },
      (_, index) => `APPEND HISTORY ${String(index + 1).padStart(4, "0")}\r\n`,
    ).join(""),
  );
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
    .toContain("APPEND HISTORY 5199");

  const box = await ptyTerminal(page).boundingBox();
  if (!box) throw new Error("PTY terminal is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toBeVisible();
  const frozenText = await snapshot.textContent();
  const frozenBox = await snapshot.boundingBox();

  await sendPtyOutput(
    page,
    Array.from(
      { length: 12 },
      (_, index) => `LIVE APPEND ${String(index + 1).padStart(2, "0")}\r\n`,
    ).join(""),
  );

  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
    .toContain("LIVE APPEND 12");
  await expect(snapshot).toHaveText(frozenText ?? "");
  await expect(snapshot).not.toContainText("LIVE APPEND");
  expect(await snapshot.boundingBox()).toEqual(frozenBox);
  await expect(backToBottom(page)).toHaveAttribute("aria-label", "回到最新");
});

test("ignores passive container scroll events while the reviewed frame is frozen", async ({
  page,
}) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    cols: 80,
    rows: 24,
    withVisualViewportMock: true,
  });
  await expectPtyTerminalMounted(page);

  await page.evaluate(() => window.__ptySmoke.resize(80, 24));
  await page.waitForTimeout(100);
  await sendPtyOutput(
    page,
    Array.from(
      { length: 72 },
      (_, index) => `PASSIVE SCROLL HISTORY ${String(index + 1).padStart(2, "0")}\r\n`,
    ).join(""),
  );

  const box = await ptyTerminal(page).boundingBox();
  if (!box) throw new Error("PTY terminal is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toBeVisible();
  const frozenText = await snapshot.textContent();

  await sendPtyOutput(
    page,
    "\u001b7\u001b[8;1HPASSIVE LIVE UPDATE 01                         \u001b8",
  );
  await expect.poll(() => directRenderedRowsText(page)).toContain("PASSIVE LIVE UPDATE 01");
  await expect(snapshot).toHaveText(frozenText ?? "");

  await ptyTerminal(page).evaluate((element) => {
    element.dispatchEvent(new Event("scroll"));
  });
  await sendPtyOutput(
    page,
    "\u001b7\u001b[8;1HPASSIVE LIVE UPDATE 02                         \u001b8",
  );

  await expect.poll(() => directRenderedRowsText(page)).toContain("PASSIVE LIVE UPDATE 02");
  await expect(snapshot).toHaveText(frozenText ?? "");
  await expect(snapshot).not.toContainText("PASSIVE LIVE UPDATE");
});
