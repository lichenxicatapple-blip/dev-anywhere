import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

type Provider = "claude" | "codex";

const enabled = process.env.DEV_ANYWHERE_LOCAL_PTY_CHAOS === "1";
const provider: Provider =
  process.env.DEV_ANYWHERE_LOCAL_PTY_CHAOS_PROVIDER === "codex" ? "codex" : "claude";
const chaosBin = process.env.DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN;
const chaosRoot =
  process.env.DEV_ANYWHERE_LOCAL_PTY_CHAOS_CWD ?? "/tmp/dev-anywhere-chaos/local-pty";
const proxyProfile = "local";
const proxyRelay = "local";
const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");

test.setTimeout(120_000);

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();

  const firstProxy = page.locator('[data-slot="proxy-item"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 15_000 });
  await firstProxy.click();
}

async function startLocalRuntime(cwd: string, screenName: string): Promise<void> {
  if (!chaosBin) throw new Error("DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN is required");
  const providerBinEnv = provider === "codex" ? `CODEX_BIN=${chaosBin}` : `CLAUDE_BIN=${chaosBin}`;
  await execFileAsync(
    "screen",
    [
      "-dmS",
      screenName,
      "env",
      `DEV_ANYWHERE_CWD=${cwd}`,
      "TERM=xterm-256color",
      providerBinEnv,
      "pnpm",
      "--dir",
      repoRoot,
      "--filter",
      "@dev-anywhere/proxy",
      "run",
      "dev",
      "--",
      "--profile",
      proxyProfile,
      provider,
    ],
    { cwd: repoRoot, timeout: 10_000, env: process.env },
  );
}

async function stopLocalRuntime(screenName: string): Promise<void> {
  await execFileAsync("screen", ["-S", screenName, "-X", "quit"], {
    cwd: repoRoot,
    timeout: 5_000,
  }).catch(() => undefined);
}

async function restartServeOnly(): Promise<void> {
  await execFileAsync(
    "pnpm",
    [
      "--filter",
      "@dev-anywhere/proxy",
      "run",
      "dev",
      "--",
      "--profile",
      proxyProfile,
      "serve",
      "restart",
      "--relay",
      proxyRelay,
    ],
    {
      cwd: repoRoot,
      timeout: 30_000,
      env: process.env,
    },
  );
}

async function terminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", sessionId);
}

async function openLocalRuntimeSession(page: Page, uniqueName: string): Promise<string> {
  await page.goto("/#/sessions");
  await selectFirstProxy(page);

  const row = page
    .locator('[data-slot="session-row"]:visible')
    .filter({ hasText: uniqueName })
    .filter({ hasText: provider === "codex" ? "Codex" : "Claude Code" })
    .filter({ has: page.locator('[data-slot="session-mode-icon"][data-mode="pty"]') });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.locator("button").first().click();
  await expect(page).toHaveURL(/\/chat\/[^?]+\?mode=pty/, { timeout: 15_000 });
  const sessionId = new URL(page.url()).hash.match(/\/chat\/([^?]+)/)?.[1];
  expect(sessionId).toBeTruthy();
  await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
  return sessionId!;
}

async function sendRemoteLine(page: Page, sessionId: string, text: string): Promise<void> {
  const input = page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  await page.keyboard.type(text);
  await input.press("Enter");
  await expect
    .poll(() => terminalText(page, sessionId), { timeout: 15_000 })
    .toContain(`received: ${text}`);
}

async function detachRemoteView(page: Page, sessionId: string): Promise<void> {
  await page.goto("/#/sessions");
  const row = page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[data-slot="session-row-menu-trigger"]').click();
  await page.locator('[data-slot="session-row-terminate-item"]').click();
  await page.locator('[data-slot="session-termination-confirm"]').click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
}

test.describe("real local runtime PTY chaos", () => {
  test(`keeps a local-terminal ${provider} PTY usable across serve restart and detach`, async ({
    page,
  }) => {
    test.skip(
      !enabled,
      "integration chaos: 需要 `pnpm dev:chaos` 编排起 local PTY runtime 并注入 chaos provider (DEV_ANYWHERE_LOCAL_PTY_CHAOS=1 + DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN)",
    );
    test.skip(!chaosBin, "DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN missing");

    const uniqueName = `dev-anywhere-local-pty-${provider}-${Date.now()}`;
    const cwd = `${chaosRoot.replace(/\/$/, "")}/${uniqueName}`;
    const screenName = `dev-anywhere-local-pty-${provider}-${Date.now()}`;
    mkdirSync(cwd, { recursive: true });
    await startLocalRuntime(cwd, screenName);

    try {
      const sessionId = await openLocalRuntimeSession(page, uniqueName);
      await expect
        .poll(() => terminalText(page, sessionId), { timeout: 30_000 })
        .toContain("DEV Anywhere local PTY ready");

      await sendRemoteLine(page, sessionId, "before-serve-restart");

      await restartServeOnly();
      await page.goto("/#/sessions");
      await selectFirstProxy(page);
      await page
        .locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`)
        .locator("button")
        .first()
        .click();
      await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}\\?mode=pty`), {
        timeout: 30_000,
      });
      await expect
        .poll(() => terminalText(page, sessionId), { timeout: 30_000 })
        .toContain("before-serve-restart");

      await sendRemoteLine(page, sessionId, "after-serve-restart");
      await detachRemoteView(page, sessionId);
    } finally {
      await stopLocalRuntime(screenName);
    }
  });
});
