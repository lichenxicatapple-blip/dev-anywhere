import { expect, type Page } from "@playwright/test";

export async function touchPtyTerminal(page: Page): Promise<void> {
  const box = await page.locator('[data-slot="pty-terminal"]').boundingBox();
  if (!box) throw new Error("PTY terminal missing");

  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          x: box.x + box.width / 2,
          y: box.y + Math.min(box.height / 2, 160),
          id: 1,
          radiusX: 3,
          radiusY: 3,
          force: 1,
        },
      ],
    });
    await page.waitForTimeout(80);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

export async function waitForSoftKeyboard(page: Page): Promise<boolean> {
  try {
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Number(
              document
                .querySelector("[data-keyboard-offset]")
                ?.getAttribute("data-keyboard-offset") ?? "0",
            ),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    return true;
  } catch {
    return false;
  }
}

export async function touchPtyTerminalAndWaitForSoftKeyboard(page: Page): Promise<boolean> {
  await touchPtyTerminal(page);
  await expect(page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'))
    .toBeFocused();
  return waitForSoftKeyboard(page);
}
