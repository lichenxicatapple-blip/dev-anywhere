import { expect, test } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import {
  backToBottom,
  backToBottomNewIndicator,
  expectPtyCursorAwareBottom,
  expectPtyRendered,
  ptyTerminal,
  readPtyScrollMetrics,
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

interface VisibleNativeRow {
  text: string;
  top: number;
  bottom: number;
  height: number;
  fullyVisible: boolean;
}

async function visibleNativeRows(
  page: import("@playwright/test").Page,
): Promise<VisibleNativeRow[]> {
  return ptyTerminal(page).evaluate((container) => {
    const containerRect = container.getBoundingClientRect();
    const containerStyle = getComputedStyle(container);
    const contentTop = containerRect.top + (Number.parseFloat(containerStyle.paddingTop) || 0);
    const contentBottom =
      containerRect.bottom - (Number.parseFloat(containerStyle.paddingBottom) || 0);
    const screen = container.querySelector<HTMLElement>('[data-slot="pty-host"] .xterm-screen');
    if (!screen) return [];
    const nativeRows = Array.from(screen.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains("xterm-rows") &&
        child.dataset.slot === undefined,
    );
    if (!nativeRows) return [];

    return Array.from(nativeRows.children)
      .filter((row): row is HTMLElement => row instanceof HTMLElement)
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          text: row.textContent ?? "",
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          fullyVisible: rect.top >= contentTop - 1 && rect.bottom <= contentBottom + 1,
        };
      })
      .filter((row) => row.bottom > contentTop && row.top < contentBottom);
  });
}

async function waitForAnimationFrames(
  page: import("@playwright/test").Page,
  count = 2,
): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

test("keeps a partially visible live status updating after a shallow wheel-up", async ({
  page,
}) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    sessionKind: "agent",
    provider: "claude",
    ptyOwner: "proxy-hosted",
    cols: 80,
    rows: 40,
    withVisualViewportMock: true,
  });
  await expectPtyTerminalMounted(page);

  await page.evaluate(() => window.__ptySmoke.resize(80, 40));
  await page.waitForTimeout(100);
  await sendPtyOutput(
    page,
    `${Array.from(
      { length: 160 },
      (_, index) => `STATUS HISTORY ${String(index + 1).padStart(3, "0")}\r\n`,
    ).join("")}WORKING elapsed 01s`,
  );
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
    .toContain("WORKING elapsed 01s");
  await expectPtyCursorAwareBottom(page);

  const box = await ptyTerminal(page).boundingBox();
  if (!box) throw new Error("PTY terminal is not visible");
  const cellHeight = await page
    .locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows > div')
    .first()
    .evaluate((row) => row.getBoundingClientRect().height);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -Math.max(9, Math.ceil(cellHeight * 0.75)));
  await waitForAnimationFrames(page);

  // Review is scroll intent only. It must not replace live xterm rows with a serialized frame.
  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toHaveCount(0);
  await expect(backToBottom(page)).toHaveAttribute("aria-label", "回到底部");

  const before = (await visibleNativeRows(page)).find((row) =>
    row.text.includes("WORKING elapsed 01s"),
  );
  expect(before, "the live Working row should remain partially visible").toBeTruthy();
  expect(before?.fullyVisible).toBe(false);

  await sendPtyOutput(page, "\rWORKING elapsed 02s\u001b[K");

  await expect.poll(() => directRenderedRowsText(page)).toContain("WORKING elapsed 02s");
  await expect(snapshot).toHaveCount(0);
  const after = (await visibleNativeRows(page)).find((row) =>
    row.text.includes("WORKING elapsed 02s"),
  );
  expect(after, "the updated Working row should still be visible").toBeTruthy();
  expect(after?.top).toBeCloseTo(before?.top ?? Number.NaN, 0);
});

test("anchors history during output and traverses appended rows before reaching the live tail", async ({
  page,
}) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    sessionKind: "agent",
    provider: "claude",
    ptyOwner: "proxy-hosted",
    cols: 80,
    rows: 40,
    withVisualViewportMock: true,
  });
  await expectPtyTerminalMounted(page);

  await page.evaluate(() => window.__ptySmoke.resize(80, 40));
  await page.waitForTimeout(100);
  await sendPtyOutput(
    page,
    Array.from(
      { length: 300 },
      (_, index) => `APPEND HISTORY ${String(index + 1).padStart(3, "0")}\r\n`,
    ).join(""),
  );
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
    .toContain("APPEND HISTORY 300");
  await expectPtyCursorAwareBottom(page);

  const box = await ptyTerminal(page).boundingBox();
  if (!box) throw new Error("PTY terminal is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -360);
  await waitForAnimationFrames(page);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toHaveCount(0);
  const anchor = (await visibleNativeRows(page)).find(
    (row) => row.fullyVisible && row.text.includes("APPEND HISTORY"),
  );
  expect(anchor, "a fully visible history row is required as the viewport anchor").toBeTruthy();

  await sendPtyOutput(
    page,
    Array.from(
      { length: 48 },
      (_, index) => `LIVE APPEND ${String(index + 1).padStart(2, "0")}\r\n`,
    ).join(""),
  );
  await expect
    .poll(() => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID))
    .toContain("LIVE APPEND 48");
  await waitForAnimationFrames(page);

  const anchoredAfterOutput = (await visibleNativeRows(page)).find(
    (row) => row.text === anchor?.text,
  );
  expect(anchoredAfterOutput, "background output must not replace the row being read").toBeTruthy();
  expect(anchoredAfterOutput?.top).toBeCloseTo(anchor?.top ?? Number.NaN, 0);
  await expect(snapshot).toHaveCount(0);
  await expect(backToBottomNewIndicator(page)).toBeVisible();

  const cellHeight = anchor?.height ?? 0;
  const traversedFrames: string[] = [];
  for (let step = 0; step < 24; step += 1) {
    const beforeStep = await readPtyScrollMetrics(page);
    if (beforeStep.bottomGap <= 8) break;

    await page.mouse.wheel(0, 120);
    await waitForAnimationFrames(page);
    const afterStep = await readPtyScrollMetrics(page);
    const travel = afterStep.scrollTop - beforeStep.scrollTop;
    expect(
      travel,
      `wheel step ${step + 1} must not jump across the appended range`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      travel,
      `wheel step ${step + 1} must remain proportional to its 120px input`,
    ).toBeLessThanOrEqual(120 + cellHeight + 2);
    traversedFrames.push((await visibleNativeRows(page)).map((row) => row.text).join("\n"));
  }

  expect(
    traversedFrames.some(
      (text) => /LIVE APPEND (?:0[1-9]|1\d)/.test(text) && !text.includes("LIVE APPEND 48"),
    ),
    "ordinary downward scrolling should expose intermediate appended rows before the latest row",
  ).toBe(true);

  await expect(snapshot).toHaveCount(0);
  await expect(backToBottom(page)).toHaveJSProperty("inert", true);
  await expect.poll(() => directRenderedRowsText(page)).toContain("LIVE APPEND 48");
  await expectPtyCursorAwareBottom(page);
});

test("keeps dim truecolor foregrounds unchanged while scrolling native rows", async ({ page }) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    sessionKind: "agent",
    provider: "claude",
    ptyOwner: "proxy-hosted",
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
  await waitForAnimationFrames(page);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toHaveCount(0);
  const scrolledAppearance = await page
    .locator('[data-slot="pty-host"] .xterm-screen > .xterm-rows:not([data-slot])')
    .evaluate((element) => {
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
  expect(scrolledAppearance).toEqual({ color: liveAppearance.color, opacity: 1 });
});

test("keeps native live rows authoritative across passive container scroll events", async ({
  page,
}) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    sessionKind: "agent",
    provider: "claude",
    ptyOwner: "proxy-hosted",
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
  await waitForAnimationFrames(page);

  const snapshot = page.locator('[data-slot="pty-review-snapshot"]');
  await expect(snapshot).toHaveCount(0);

  await sendPtyOutput(
    page,
    "\u001b7\u001b[8;1HPASSIVE LIVE UPDATE 01                         \u001b8",
  );
  await expect.poll(() => directRenderedRowsText(page)).toContain("PASSIVE LIVE UPDATE 01");
  await expect(snapshot).toHaveCount(0);

  await ptyTerminal(page).evaluate((element) => {
    element.dispatchEvent(new Event("scroll"));
  });
  await sendPtyOutput(
    page,
    "\u001b7\u001b[8;1HPASSIVE LIVE UPDATE 02                         \u001b8",
  );

  await expect.poll(() => directRenderedRowsText(page)).toContain("PASSIVE LIVE UPDATE 02");
  await expect(snapshot).toHaveCount(0);
});

test("preserves BCE-only padding around Codex prompts while scrolling native rows", async ({
  page,
}) => {
  await setupPtyChat(page, {
    sessionId: SESSION_ID,
    sessionKind: "agent",
    provider: "codex",
    ptyOwner: "proxy-hosted",
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
  await expect(snapshot).toHaveCount(0);
  const nativeRows = page.locator(
    '[data-slot="pty-host"] .xterm-screen > .xterm-rows:not([data-slot])',
  );
  await expect(nativeRows).toContainText("真实 Codex 历史输入");
  const bottomPaddingBackground = await nativeRows.evaluate((element) => {
    const promptRow = Array.from(element.children).findIndex((row) =>
      row.textContent?.includes("真实 Codex 历史输入"),
    );
    const bottomPadding = promptRow >= 0 ? element.children[promptRow + 1] : null;
    const contentSpan = bottomPadding
      ? Array.from(bottomPadding.children).find((child) => child.textContent?.length)
      : null;
    return contentSpan instanceof HTMLElement
      ? getComputedStyle(contentSpan).backgroundColor
      : null;
  });
  expect(bottomPaddingBackground).toBe("rgb(57, 57, 57)");
});
