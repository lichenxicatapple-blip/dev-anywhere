import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import {
  backToBottom,
  backToBottomNewIndicator,
  expectPtyCursorAwareBottom,
  expectPtyRendered,
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
  await expectPtyCursorAwareBottom(page);
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

test("keeps dim truecolor foregrounds unchanged when review projection takes over", async ({
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
    [
      Array.from({ length: 30 }, (_, index) => `COLOR HISTORY ${index + 1}\r\n`).join(""),
      "\u001b[2;38;2;205;214;244;48;2;74;34;29mRGB DIM TARGET\u001b[0m\r\n",
      Array.from({ length: 6 }, (_, index) => `COLOR LATER ${index + 1}\r\n`).join(""),
    ].join(""),
  );
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
    .toContain("RGB DIM TARGET");
  await expectPtyRendered(page);

  const liveAppearance = await page
    .locator('[data-slot="pty-host"] .xterm-screen')
    .evaluate((screen) => {
      const renderedRows = Array.from(screen.children).find(
        (child) => child instanceof HTMLElement && child.classList.contains("xterm-rows"),
      );
      const glyph = renderedRows
        ? Array.from(renderedRows.querySelectorAll<HTMLElement>("span"))
            .filter((span) => span.textContent?.includes("RGB DIM TARGET"))
            .at(-1)
        : null;
      if (!glyph) return null;
      return { color: getComputedStyle(glyph).color, opacity: getComputedStyle(glyph).opacity };
    });
  expect(liveAppearance).toEqual({ color: "rgb(205, 214, 244)", opacity: "1" });
  if (!liveAppearance) throw new Error("live truecolor target glyph is unavailable");

  const box = await ptyTerminal(page).boundingBox();
  if (!box) throw new Error("PTY terminal is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -80);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toContainText("RGB DIM TARGET");
  const projectedAppearance = await snapshot.evaluate((element) => {
    const glyph = Array.from(element.querySelectorAll<HTMLElement>("span"))
      .filter((span) => span.textContent?.includes("RGB DIM TARGET"))
      .at(-1);
    if (!glyph) return null;
    let effectiveOpacity = 1;
    for (let current: HTMLElement | null = glyph; current && current !== element; ) {
      effectiveOpacity *= Number.parseFloat(getComputedStyle(current).opacity);
      current = current.parentElement;
    }
    return { color: getComputedStyle(glyph).color, opacity: effectiveOpacity };
  });
  expect(projectedAppearance).toEqual({ color: liveAppearance.color, opacity: 1 });
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

test("preserves BCE-only padding around Codex prompts in the reviewed frame", async ({ page }) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    provider: "codex",
    cols: 80,
    rows: 24,
    withVisualViewportMock: true,
  });
  await expectPtyTerminalMounted(page);

  await page.evaluate(() => window.__ptySmoke.resize(80, 24));
  await page.waitForTimeout(100);
  const gray = "\u001b[48;2;57;57;57m";
  const reset = "\u001b[0m";
  await sendPtyOutput(
    page,
    [
      Array.from({ length: 48 }, (_, index) => `BCE HISTORY ${index + 1}\r\n`).join(""),
      `${gray}\u001b[2K${reset}\r\n`,
      `${gray}› 真实 Codex 历史输入\u001b[K${reset}\r\n`,
      `${gray}\u001b[2K${reset}\r\n`,
      Array.from({ length: 30 }, (_, index) => `BCE LATER ${index + 1}\r\n`).join(""),
    ].join(""),
  );
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
    .toContain("真实 Codex 历史输入");

  const targetLine = await ptyTerminal(page).evaluate((container, sessionId) => {
    const terminal = window.__ccTestPtyTerminals?.get(sessionId);
    if (!terminal) throw new Error("PTY terminal is unavailable");
    let targetLine = -1;
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      if (
        terminal.buffer.active
          .getLine(index)
          ?.translateToString(true)
          .includes("真实 Codex 历史输入")
      ) {
        targetLine = index;
        break;
      }
    }
    if (targetLine < 0) throw new Error("Codex prompt row is unavailable");
    const renderedRow = container.querySelector<HTMLElement>(".xterm-rows > div");
    const cellHeight = renderedRow?.getBoundingClientRect().height ?? 18;
    const targetScrollTop = Math.max(0, (targetLine - 5) * cellHeight);
    container.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: targetScrollTop - container.scrollTop,
      }),
    );
    return targetLine;
  }, SESSION_ID);

  await expect
    .poll(() =>
      page.evaluate(
        ({ sessionId, line }) => {
          const terminal = window.__ccTestPtyTerminals?.get(sessionId);
          if (!terminal) return false;
          const row = line - terminal.buffer.active.viewportY;
          return row >= 1 && row < terminal.rows - 1;
        },
        { sessionId: SESSION_ID, line: targetLine },
      ),
    )
    .toBe(true);
  await expectPtyRendered(page);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toContainText("真实 Codex 历史输入");
  const bottomPaddingBackground = await snapshot.evaluate((element) => {
    const rows = element.querySelector(".xterm-rows");
    const promptRow = rows
      ? Array.from(rows.children).findIndex((row) =>
          row.textContent?.includes("真实 Codex 历史输入"),
        )
      : -1;
    const bottomPadding = promptRow >= 0 ? rows?.children[promptRow + 1] : null;
    const contentSpan = bottomPadding
      ? Array.from(bottomPadding.children).find((child) => child.textContent?.length)
      : null;
    return contentSpan instanceof HTMLElement
      ? getComputedStyle(contentSpan).backgroundColor
      : null;
  });
  expect(bottomPaddingBackground).toBe("rgb(57, 57, 57)");
});
