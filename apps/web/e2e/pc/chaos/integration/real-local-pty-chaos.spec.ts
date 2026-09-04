import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  requireE2EBackendConfig,
  type E2EBackendConfig,
} from "../../../fixtures/real-backend-config";

type Provider = "claude" | "codex";

const enabled = process.env.DEV_ANYWHERE_LOCAL_PTY_CHAOS === "1";
const provider: Provider =
  process.env.DEV_ANYWHERE_LOCAL_PTY_CHAOS_PROVIDER === "codex" ? "codex" : "claude";
const chaosBin = process.env.DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN;
const chaosRoot =
  process.env.DEV_ANYWHERE_LOCAL_PTY_CHAOS_CWD ?? "/tmp/dev-anywhere-chaos/local-pty";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
const proxyEntry = resolve(repoRoot, "apps/proxy/src/index.ts");

test.setTimeout(120_000);

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();

  const firstProxy = page.locator('[data-slot="proxy-item"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 15_000 });
  await firstProxy.click();
}

async function runProcess(file: string, args: string[], timeout: number): Promise<void> {
  await new Promise<void>((resolveProcess, reject) => {
    const child = spawn(file, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${file} timed out after ${timeout}ms`));
    }, timeout);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveProcess();
        return;
      }
      reject(new Error(`${file} exited with code=${code} signal=${signal}`));
    });
  });
}

async function startLocalRuntime(
  cwd: string,
  screenName: string,
  config: E2EBackendConfig,
): Promise<void> {
  if (!chaosBin) throw new Error("DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN is required");
  const providerBinEnv = provider === "codex" ? `CODEX_BIN=${chaosBin}` : `CLAUDE_BIN=${chaosBin}`;
  await runProcess(
    "screen",
    [
      "-dmS",
      screenName,
      "env",
      `DEV_ANYWHERE_CWD=${cwd}`,
      "TERM=xterm-256color",
      providerBinEnv,
      tsxBin,
      proxyEntry,
      "--profile",
      config.profile,
      provider,
    ],
    10_000,
  );
}

async function stopLocalRuntime(screenName: string): Promise<void> {
  await runProcess("screen", ["-S", screenName, "-X", "quit"], 5_000).catch(() => undefined);
}

async function restartServeOnly(config: E2EBackendConfig): Promise<void> {
  const args = [
    "--filter",
    "@dev-anywhere/proxy",
    "run",
    "dev",
    "--",
    "--profile",
    config.profile,
    "serve",
    "restart",
  ];
  if (config.relay) args.push("--relay", config.relay);
  await runProcess("pnpm", args, 30_000);
}

async function terminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", sessionId);
}

async function clickLiveSessionRow(page: Page, row: ReturnType<Page["locator"]>): Promise<void> {
  await expect(row).toBeVisible({ timeout: 30_000 });
  const button = row.locator("button").first();
  await expect(button).toBeEnabled({ timeout: 15_000 });
  // The live session list replaces rows whenever reconnect metadata changes.
  // Playwright's actionability click may therefore observe a different DOM node
  // on every animation frame. Resolve and click the current React button in one
  // browser task; this still exercises the real row handler and router.
  await button.evaluate((element: HTMLButtonElement) => element.click());
}

async function openLocalRuntimeSession(page: Page, uniqueName: string): Promise<string> {
  await page.goto("/#/sessions");
  await selectFirstProxy(page);

  const row = page
    .locator('[data-slot="session-row"]:visible')
    .filter({ hasText: uniqueName })
    .filter({ hasText: provider === "codex" ? "Codex" : "Claude Code" })
    .filter({ has: page.locator('[data-slot="session-mode-icon"][data-mode="pty"]') });
  await clickLiveSessionRow(page, row);
  await expect(page).toHaveURL(/\/chat\/[^?]+\?mode=pty/, { timeout: 15_000 });
  const sessionId = new URL(page.url()).hash.match(/\/chat\/([^?]+)/)?.[1];
  expect(sessionId).toBeTruthy();
  await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
  return sessionId!;
}

async function sendRemoteLine(page: Page, sessionId: string, text: string): Promise<void> {
  await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
    "data-connection-ready",
    "true",
    { timeout: 30_000 },
  );
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
    const backendConfig = requireE2EBackendConfig();

    const uniqueName = `dev-anywhere-local-pty-${provider}-${Date.now()}`;
    const cwd = `${chaosRoot.replace(/\/$/, "")}/${uniqueName}`;
    const screenName = `dev-anywhere-local-pty-${backendConfig.profile}-${provider}-${Date.now()}`;
    mkdirSync(cwd, { recursive: true });
    await test.step("start local terminal runtime", () =>
      startLocalRuntime(cwd, screenName, backendConfig));

    try {
      const sessionId = await test.step("open local terminal session", async () => {
        const id = await openLocalRuntimeSession(page, uniqueName);
        await expect
          .poll(() => terminalText(page, id), { timeout: 30_000 })
          .toContain("DEV Anywhere local PTY ready");
        return id;
      });

      await test.step("send input before serve restart", () =>
        sendRemoteLine(page, sessionId, "before-serve-restart"));

      await test.step("restart serve daemon", () => restartServeOnly(backendConfig));
      await test.step("reopen reconnected terminal session", async () => {
        await page.goto("/#/sessions", { waitUntil: "domcontentloaded", timeout: 20_000 });
        await selectFirstProxy(page);
        await clickLiveSessionRow(
          page,
          page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`),
        );
        await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}\\?mode=pty`), {
          timeout: 30_000,
        });
        await expect
          .poll(() => terminalText(page, sessionId), { timeout: 30_000 })
          .toContain("before-serve-restart");
      });

      await test.step("send input after serve restart", () =>
        sendRemoteLine(page, sessionId, "after-serve-restart"));
      await test.step("detach remote terminal view", () => detachRemoteView(page, sessionId));
    } finally {
      await stopLocalRuntime(screenName);
    }
  });
});
