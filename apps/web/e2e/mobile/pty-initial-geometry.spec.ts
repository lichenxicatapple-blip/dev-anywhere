import { test, expect, mobileBaseUrl } from "../fixtures/cdp";
import { installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "../helpers";

test.describe("L4 mobile / adaptive initial PTY geometry", () => {
  test.setTimeout(60_000);

  test("creates a terminal with extra rows while retaining the 80-column QR baseline", async ({
    emuPage,
  }) => {
    await installFakeRelay(emuPage);
    await emuPage.goto(`${mobileBaseUrl}/#/`);
    await emuPage.reload();
    await selectFakeProxy(emuPage);
    await emuPage.locator('[data-slot="create-session-mobile-trigger"]:visible').click();
    await emuPage.locator('[data-slot="create-terminal-session-sheet-item"]').click();
    await expect(emuPage).toHaveURL(/\/chat\/created-terminal-\d+\?mode=pty/, {
      timeout: 15_000,
    });

    const message = (await sentFakeRelayMessages(emuPage)).find(
      (entry) => entry.type === "session_create" && entry.kind === "terminal",
    );
    expect(Number(message?.cols)).toBeGreaterThanOrEqual(80);
    expect(Number(message?.rows)).toBeGreaterThan(24);
  });
});
