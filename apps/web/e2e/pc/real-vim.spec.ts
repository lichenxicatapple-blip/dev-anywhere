import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { decodeBinaryFrame } from "@dev-anywhere/shared";
import { spawnSessionViaRelay, type SessionViaRelay } from "../fixtures/relay-control";
import { ptyInput, readVisiblePtyRow } from "../pty-scroll-helpers";

const enabled = process.env.DEV_ANYWHERE_REAL_VIM === "1";
const relayUrl = process.env.DEV_ANYWHERE_REAL_RELAY_URL ?? "ws://127.0.0.1:6310";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:5274";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function openSession(page: Page, session: SessionViaRelay): Promise<void> {
  const response = await page.goto(`${webBaseUrl}/#/`);
  expect(response?.ok()).toBe(true);
  // The original freeze only occurred after production minification, not in Vite dev mode.
  expect(await response!.text()).not.toContain("/@vite/client");

  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  await expect(switcher).toBeVisible({ timeout: 20_000 });
  await switcher.click();
  const proxy = page
    .locator(`[data-slot="proxy-item"][data-proxy-id="${session.proxyId}"]:visible`)
    .last();
  await expect(proxy).toBeVisible({ timeout: 20_000 });
  await proxy.click();
  await expect(
    page.locator(`[data-slot="session-row"][data-session-id="${session.sessionId}"]:visible`),
  ).toBeVisible({ timeout: 20_000 });
  await page.goto(`${webBaseUrl}/#/chat/${session.sessionId}?mode=pty`);
  await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
    "data-connection-ready",
    "true",
    { timeout: 20_000 },
  );
  await expect(ptyInput(page)).toBeAttached();
}

test("real Vim keeps rendering edits and command input after querying terminal modes", async ({
  page,
}, testInfo) => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_VIM=1 to use a local Relay, Proxy and real Vim");
  test.setTimeout(90_000);
  expect(relayUrl, "real Vim tests must use a local Relay").toMatch(
    /^ws:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/,
  );
  await page.setViewportSize({ width: 1920, height: 1100 });

  const directory = await mkdtemp(join(tmpdir(), "dev-anywhere-real-vim-"));
  const fixturePath = join(directory, "fixture.txt");
  let session: SessionViaRelay | undefined;
  let terminalOutput = "";
  let terminalInput = "";
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    const decoder = new TextDecoder();
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") return;
      const frame = decodeBinaryFrame(payload);
      if (frame?.sessionId === session?.sessionId) {
        terminalOutput += decoder.decode(frame.data, { stream: true });
      }
    });
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload) as Record<string, unknown>;
      if (
        message.type === "remote_input_raw" &&
        message.sessionId === session?.sessionId &&
        typeof message.data === "string"
      ) {
        terminalInput += message.data;
      }
    });
  });

  try {
    await writeFile(
      fixturePath,
      Array.from(
        { length: 80 },
        (_, row) => `VIM_FIXTURE_LINE_${String(row + 1).padStart(3, "0")}\n`,
      ).join(""),
    );
    session = await spawnSessionViaRelay(
      { relayUrl },
      { kind: "terminal", mode: "pty", cols: 175, rows: 43 },
    );
    expect(session.ptyOwner).toBe("proxy-hosted");
    await openSession(page, session);

    session.send({
      type: "remote_input_raw",
      sessionId: session.sessionId,
      data:
        "stty -echo; printf '\nVIM_PTY_SIZE '; stty size; " +
        'i=1; while [ "$i" -le 1500 ]; do printf \'VIM_HISTORY_%04d\\n\' "$i"; ' +
        "i=$((i + 1)); done; stty echo\r",
    });
    await expect.poll(() => terminalOutput).toMatch(/VIM_PTY_SIZE\s+43\s+175/);
    await expect
      .poll(() => readVisiblePtyRow(page, "VIM_HISTORY_1500"), { timeout: 20_000 })
      .not.toBeNull();

    // This is a real Vim process: observe its live query and the browser's answer. No output
    // replay, injected ANSI, DEV-only terminal hooks or refresh can conceal a stalled parser.
    terminalOutput = "";
    terminalInput = "";
    session.send({
      type: "remote_input_raw",
      sessionId: session.sessionId,
      data:
        `LC_ALL=C TERM=xterm-256color /usr/bin/vim -n -i NONE -c 'set showmode' ${shellQuote(fixturePath)}; ` +
        "printf '\nVIM_RETURNED_TO_SHELL\n'\r",
    });
    await expect
      .poll(
        () => ({
          sawModeQuery: terminalOutput.includes("\x1b[?12$p"),
          sawModeReply: [0, 1, 2, 3, 4].some((mode) =>
            terminalInput.includes(`\x1b[?12;${mode}$y`),
          ),
          pageErrors,
        }),
        { timeout: 20_000 },
      )
      .toEqual({ sawModeQuery: true, sawModeReply: true, pageErrors: [] });
    await expect.poll(() => readVisiblePtyRow(page, "VIM_FIXTURE_LINE_001")).not.toBeNull();

    const rows = page.locator('[data-slot="pty-host"] .xterm-rows > div');
    await ptyInput(page).focus();
    await page.keyboard.type("i");
    await expect.poll(() => readVisiblePtyRow(page, "-- INSERT --")).not.toBeNull();
    await page.keyboard.type("VIM_REAL_EDIT_");
    const editedText = "VIM_REAL_EDIT_VIM_FIXTURE_LINE_001";
    await expect.poll(() => readVisiblePtyRow(page, editedText)).not.toBeNull();
    const cursor = rows.filter({ hasText: editedText }).locator(".xterm-cursor");
    await expect(cursor).toBeVisible();
    await expect(cursor).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("vim-editing.png"), animations: "disabled" });

    await page.keyboard.press("Escape");
    await expect(rows.filter({ hasText: "-- INSERT --" })).toHaveCount(0);
    await page.keyboard.type(":q!");
    await expect.poll(() => readVisiblePtyRow(page, ":q!")).not.toBeNull();
    await expect(rows.last()).toHaveText(/^:q!\s*$/);
    await expect(rows.last()).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("vim-command.png"), animations: "disabled" });

    await page.keyboard.press("Enter");
    await expect.poll(() => readVisiblePtyRow(page, "VIM_RETURNED_TO_SHELL")).not.toBeNull();
    await expect.poll(() => readVisiblePtyRow(page, "VIM_HISTORY_1500")).not.toBeNull();
    await expect(rows.filter({ hasText: editedText })).toHaveCount(0);
    expect(terminalInput).toContain("iVIM_REAL_EDIT_\x1b:q!\r");
    expect(terminalOutput).toContain("\x1b[?1049l");
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await session?.terminate();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
