import { expect, test } from "@playwright/test";
import { gotoWithFakeProxy, installFakeRelay, sentFakeRelayMessages } from "../helpers";

test.describe("session rename", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
  });

  test("locks renamed PTY session titles across OSC updates and page reloads", async ({ page }) => {
    const headerTitle = page.locator('[data-slot="chat-session-title"]');
    await expect(headerTitle).toContainText("Claude Code");

    await page.evaluate(() => window.__ccTest?.session.setPtyTitle("claude-pty", "✻ Working"));
    await expect(headerTitle).toContainText("Working");

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await page.locator('[data-slot="chat-menu-rename"]').click();
    await page.getByLabel("会话标题").fill("Release checklist");
    await page.getByRole("button", { name: "保存" }).click();

    await expect(headerTitle).toHaveText("Release checklist");
    await expect(
      page.locator('[data-slot="session-row"][data-session-id="claude-pty"]:visible'),
    ).toContainText("Release checklist");
    await expect
      .poll(async () => sentFakeRelayMessages(page))
      .toContainEqual(expect.objectContaining({ type: "session_rename", sessionId: "claude-pty" }));

    await page.evaluate(() =>
      window.__ccTest?.session.setPtyTitle("claude-pty", "✻ Another OSC Title"),
    );
    await expect(headerTitle).toHaveText("Release checklist");

    await page.reload();
    await expect(headerTitle).toHaveText("Release checklist");
    await expect(
      page.locator(
        '[data-slot="session-row"][data-session-id="claude-pty"]:visible [title="/home/dev/projects/sample-app/"]',
      ),
    ).toContainText("Release checklist");
  });
});
