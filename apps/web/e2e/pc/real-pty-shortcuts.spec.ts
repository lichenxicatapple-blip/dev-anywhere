import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BASE_URL } from "../helpers";
import { spawnSessionViaRelay, type SessionViaRelay } from "../fixtures/relay-control";
import { installVisualViewportMock } from "../mobile-helpers";

const enabled = process.env.DEV_ANYWHERE_REAL_PTY_SHORTCUTS === "1";
const relayUrl = process.env.DEV_ANYWHERE_REAL_RELAY_URL ?? "ws://127.0.0.1:3101";

test.use({ viewport: { width: 360, height: 704 }, hasTouch: true });
test.beforeEach(async ({ page }) => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_PTY_SHORTCUTS=1 to exercise real local CLIs");
  test.skip(!/^ws:\/\/(localhost|127\.0\.0\.1):\d+$/.test(relayUrl), "requires a local Relay");
  // Desktop Chromium has no OS soft keyboard. Only its viewport is simulated; Relay,
  // PTY input/output and each CLI run normally. Android hit testing has its own gate.
  await installVisualViewportMock(page);
});

async function open(page: Page, session: SessionViaRelay) {
  await page.goto(`${BASE_URL}/#/`);
  await page
    .locator(`[data-slot="proxy-item"][data-proxy-id="${session.proxyId}"]:visible`)
    .last()
    .click();
  await expect(
    page.locator(`[data-slot="session-row"][data-session-id="${session.sessionId}"]:visible`),
  ).toBeVisible();
  await page.goto(`${BASE_URL}/#/chat/${session.sessionId}?mode=pty`);
  await expect(
    page.locator(`[data-slot="pty-keepalive-entry"][data-session-id="${session.sessionId}"]`),
  ).toHaveAttribute("data-active", "true");
  await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
    "data-connection-ready",
    "true",
  );
}

async function inspect(page: Page, id: string) {
  return page.evaluate((sessionId) => {
    const term = window.__ccTestPtyTerminals?.get(sessionId);
    if (!term) return null;
    return {
      x: term.buffer.active.cursorX,
      y: term.buffer.active.cursorY,
      line:
        term.buffer.active
          .getLine(term.buffer.active.baseY + term.buffer.active.cursorY)
          ?.translateToString(true)
          .trimEnd() ?? "",
      text: window.__ccTest?.pty.serialize(sessionId) ?? "",
      screen: Array.from(
        { length: term.rows },
        (_, row) =>
          term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true) ?? "",
      ).join("\n"),
    };
  }, id);
}

async function type(page: Page, text: string) {
  await page.locator('[data-slot="pty-terminal"]').click();
  await page.keyboard.type(text);
}

async function mobile(page: Page, key: string) {
  await expect(page.locator('[data-slot="chat-overflow-menu"]')).toHaveCount(0);
  await page.locator('[data-slot="pty-terminal"]:visible').click();
  await page.evaluate(() => window.__devAnywhereSetVisualViewport?.({ height: 400, offsetTop: 0 }));
  await page.getByRole("button", { name: `发送 ${key}`, exact: true }).click();
}

async function clearDraft(page: Page) {
  await page.locator('[data-slot="pty-terminal"]:visible').click();
  await page.evaluate(() => window.__devAnywhereSetVisualViewport?.({ height: 400, offsetTop: 0 }));
  const clear = page.getByRole("button", { name: "清空输入区", exact: true });
  await expect(clear).not.toHaveAttribute("aria-disabled", "true");
  await clear.click();
}

async function menu(page: Page, key: string) {
  await page.locator('[data-slot="chat-overflow-trigger"]').click();
  await page.getByRole("menuitem", { name: "发送快捷键", exact: true }).click();
  await page.getByRole("menuitem", { name: `发送 ${key}`, exact: true }).click();
  await expect(page.locator('[data-slot="chat-overflow-menu"]')).toHaveCount(0);
}

const linuxSshHost = process.env.DEV_ANYWHERE_SHORTCUTS_LINUX_SSH;
if (linuxSshHost && !/^[a-zA-Z0-9._-]+$/.test(linuxSshHost)) {
  throw new Error("DEV_ANYWHERE_SHORTCUTS_LINUX_SSH must be an SSH host alias");
}

const shellCases = ["bash", "zsh", ...(linuxSshHost ? ["linux-bash"] : [])];
for (const shell of shellCases) {
  test(`edits real ${shell} input and searches history through the Shell controls`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const session = await spawnSessionViaRelay(
      { relayUrl },
      { kind: "terminal", mode: "pty", cols: 80, rows: 24 },
    );
    const send = (data: string) =>
      session.send({ type: "remote_input_raw", sessionId: session.sessionId, data });
    const state = () => inspect(page, session.sessionId);
    try {
      await open(page, session);
      if (shell === "linux-bash") {
        send(
          `ssh -tt -o BatchMode=yes -o ConnectTimeout=8 ${linuxSshHost} "env INPUTRC=/dev/null HISTFILE=/dev/null 'PS1=SHORTCUT> ' bash --noprofile --norc -i"\r`,
        );
      } else {
        send(
          shell === "bash"
            ? "INPUTRC=/dev/null exec /bin/bash --noprofile --norc\r"
            : "exec /bin/zsh -f\r",
        );
        send("PS1='SHORTCUT> '; HISTFILE=/dev/null\r");
      }
      await expect.poll(async () => (await state())?.line).toBe("SHORTCUT>");
      const start = (await state())!.x;
      await type(page, "alpha beta");
      await menu(page, "Ctrl+A");
      await expect.poll(async () => (await state())?.x).toBe(start);
      await menu(page, "Ctrl+E");
      await expect.poll(async () => (await state())?.x).toBe(start + 10);
      await menu(page, "Ctrl+W");
      await expect.poll(async () => (await state())?.line).toBe("SHORTCUT> alpha");
      await mobile(page, "Ctrl+U");
      await expect.poll(async () => (await state())?.line).toBe("SHORTCUT>");

      await type(page, "echo DA_SHORTCUT_HISTORY");
      await page.getByRole("button", { name: "回车", exact: true }).click();
      await expect.poll(async () => (await state())?.line).toBe("SHORTCUT>");
      await menu(page, "Ctrl+R");
      await type(page, "DA_SHORTCUT");
      await expect.poll(async () => (await state())?.text).toContain("DA_SHORTCUT_HISTORY");
      await expect.poll(async () => (await state())?.text).toMatch(/bck-i-search|reverse-i-search/);
      await page.screenshot({ path: testInfo.outputPath(`${shell}-history.png`) });
      await mobile(page, "Ctrl+C");
      await menu(page, "Ctrl+L");
      await expect.poll(async () => (await state())?.line).toBe("SHORTCUT>");
      await expect.poll(async () => (await state())?.y).toBe(0);
      await page.locator('[data-slot="chat-overflow-trigger"]').click();
      await page.getByRole("menuitem", { name: "发送快捷键", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "发送 Ctrl+O", exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${shell}-menu.png`) });
    } finally {
      await session.terminate();
    }
  });
}

for (const provider of ["claude", "codex", "kimi"] as const) {
  test(`uses the ${provider} preset with a real CLI and clears the whole draft`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const cwd = resolve("../../artifacts/shortcut-verification/empty-project");
    await mkdir(cwd, { recursive: true });
    const session = await spawnSessionViaRelay(
      { relayUrl },
      { kind: "agent", mode: "pty", provider, cwd, cols: 80, rows: 29 },
    );
    const state = () => inspect(page, session.sessionId);
    const send = (data: string) =>
      session.send({ type: "remote_input_raw", sessionId: session.sessionId, data });
    try {
      await open(page, session);
      await expect
        .poll(async () => (await state())?.text ?? "")
        .toMatch(/trust|Trust|OpenAI Codex|No session yet|Claude Code/);
      if (/trust this|Trust this|trust the files|trust this folder/i.test((await state())!.text))
        send("\r");
      await expect
        .poll(async () => (await state())?.text ?? "")
        .toMatch(/OpenAI Codex|No session yet|Claude Code/);
      await expect.poll(async () => (await state())?.x).toBe(provider === "kimi" ? 5 : 2);
      await type(page, "DA_SHORTCUT_DRAFT");
      await expect.poll(async () => (await state())?.line).toContain("DA_SHORTCUT_DRAFT");
      await clearDraft(page);
      await expect.poll(async () => (await state())?.line).not.toContain("DA_SHORTCUT_DRAFT");
      await type(page, "DA_STILL_EDITING");
      await expect.poll(async () => (await state())?.line).toContain("DA_STILL_EDITING");
      await clearDraft(page);
      // Clear must remove the entire multiline draft even when the caret is in the middle.
      send("\x1b[200~DA_CLEAR_FIRST\nDA_CLEAR_MIDDLE\nDA_CLEAR_LAST\x1b[201~");
      await expect.poll(async () => (await state())?.screen ?? "").toContain("DA_CLEAR_LAST");
      send("\x1b[A\x1b[D");
      await clearDraft(page);
      await expect.poll(async () => (await state())?.screen ?? "").not.toMatch(/DA_CLEAR_/);
      if (provider === "codex" || provider === "kimi") {
        const box = await page
          .getByRole("button", { name: "清空输入区", exact: true })
          .boundingBox();
        if (!box) throw new Error("clear button is not visible");
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      }
      await type(page, "DA_CLEAR_STILL_EDITING");
      await expect.poll(async () => (await state())?.line).toContain("DA_CLEAR_STILL_EDITING");
      await clearDraft(page);
      const controls = page.locator('[data-slot="pty-mobile-controls"]');
      await expect(controls.getByRole("button")).toHaveCount(14);
      await controls.screenshot({ path: testInfo.outputPath(`${provider}-controls.png`) });
      if (provider === "codex") {
        await type(page, "LEFT RIGHT");
        await expect.poll(async () => (await state())?.line).toContain("LEFT RIGHT");
        send("\x01" + "\x1b[C".repeat(5));
        await expect.poll(async () => (await state())?.x).toBe(7);
        await mobile(page, "Ctrl+K");
        await expect.poll(async () => (await state())?.line).toMatch(/LEFT\s*$/);
        await type(page, "EDITING");
        await expect.poll(async () => (await state())?.line).toContain("LEFT EDITING");
        await clearDraft(page);
      }
      if (provider !== "kimi") {
        await mobile(page, "Ctrl+R");
        await expect.poll(async () => (await state())?.text ?? "").toMatch(/history|search/i);
        await mobile(page, "Escape");
      }
      if (provider === "codex") {
        await menu(page, "Ctrl+T");
        await expect
          .poll(async () => (await state())?.text ?? "")
          .toMatch(/transcript|esc to|esc.*back|No messages/i);
        await mobile(page, "Escape");
      }
      await page.locator('[data-slot="chat-overflow-trigger"]').click();
      await page.getByRole("menuitem", { name: "发送快捷键", exact: true }).click();
      const names = await page
        .locator('[data-slot="chat-menu-shortcuts"]')
        .getByRole("menuitem")
        .allTextContents();
      expect(names.some((name) => name.includes("Ctrl+O"))).toBe(provider !== "codex");
      expect(names.some((name) => name.includes("Ctrl+R"))).toBe(provider !== "kimi");
      await page.evaluate(() =>
        window.__devAnywhereSetVisualViewport?.({ height: window.innerHeight, offsetTop: 0 }),
      );
      await page.screenshot({
        path: testInfo.outputPath(`${provider}-menu.png`),
        animations: "disabled",
      });
    } finally {
      await session.terminate();
    }
  });
}
