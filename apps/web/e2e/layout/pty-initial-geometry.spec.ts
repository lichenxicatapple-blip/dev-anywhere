import { expect, test, type Page } from "@playwright/test";
import { installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "../helpers";
import { installVisualViewportMock } from "../mobile-helpers";

async function createTerminalFromCurrentLayout(page: Page, mobile: boolean): Promise<void> {
  if (mobile) {
    await page.locator('[data-slot="create-session-mobile-trigger"]:visible').click();
    await page.locator('[data-slot="create-terminal-session-sheet-item"]').click();
  } else {
    await page.locator('[data-slot="create-session-trigger"]:visible').click();
    await page.locator('[data-slot="create-terminal-session-item"]').click();
  }
  await expect(page).toHaveURL(/\/chat\/created-terminal-\d+\?mode=pty/);
}

async function createdGeometry(page: Page): Promise<{ cols: number; rows: number }> {
  const message = (await sentFakeRelayMessages(page)).find(
    (entry) => entry.type === "session_create" && entry.kind === "terminal",
  );
  expect(message).toBeDefined();
  return {
    cols: Number(message?.cols),
    rows: Number(message?.rows),
  };
}

test.describe("adaptive initial PTY geometry", () => {
  test.beforeEach(async ({ page }) => {
    await installVisualViewportMock(page);
    await installFakeRelay(page);
  });

  test("phone portrait fills extra rows without dropping below 80x24", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await selectFakeProxy(page);
    await createTerminalFromCurrentLayout(page, true);

    const geometry = await createdGeometry(page);
    expect(geometry.cols).toBe(80);
    expect(geometry.rows).toBeGreaterThan(24);
  });

  test("iPad portrait keeps the QR baseline and uses its taller viewport", async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await selectFakeProxy(page);
    await createTerminalFromCurrentLayout(page, false);

    const geometry = await createdGeometry(page);
    expect(geometry.cols).toBeGreaterThanOrEqual(80);
    expect(geometry.rows).toBeGreaterThan(40);
  });

  test("desktop expands both columns and rows to the available content area", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 801 });
    await selectFakeProxy(page);
    await createTerminalFromCurrentLayout(page, false);

    const geometry = await createdGeometry(page);
    expect(geometry.cols).toBeGreaterThan(100);
    expect(geometry.rows).toBeGreaterThan(24);
  });
});
