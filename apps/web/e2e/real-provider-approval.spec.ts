import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

type Provider = "claude" | "codex";

const smokeCwd =
  process.env.DEV_ANYWHERE_REAL_PROVIDER_CWD ?? "/tmp/dev-anywhere-chaos/provider-approval";
const approvalTimeoutMs = Number(
  process.env.DEV_ANYWHERE_REAL_PROVIDER_APPROVAL_TIMEOUT_MS ?? 60_000,
);
const relayPort = "3100";
const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const codexReadyPattern = /Do you trust|Ready|Find and fix a bug|OpenAI Codex|Run \/review/i;
const codexUpdatePromptPattern =
  /Update available|Skip until next version|Press enter to continue/i;

test.describe.configure({ mode: "serial" });
test.setTimeout(approvalTimeoutMs + 60_000);
test.beforeAll(() => {
  mkdirSync(smokeCwd, { recursive: true });
});

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();

  const firstProxy = page.locator('[data-slot="proxy-item"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 15_000 });
  await firstProxy.click();
}

async function createHostedPtySession(page: Page, provider: Provider): Promise<string> {
  await page.goto("/#/sessions");
  await selectFirstProxy(page);

  await page.locator('button:has-text("新建会话"):visible').last().click();
  await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
  await page.getByLabel("工作目录").fill(smokeCwd);
  await page.getByRole("heading", { name: "新建会话" }).click();
  await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toHaveCount(0);
  await page
    .getByLabel("交互方式")
    .getByRole("button", { name: /终端模式/ })
    .click({ timeout: 15_000 });
  await page
    .getByLabel("Agent CLI")
    .getByRole("button", { name: provider === "claude" ? /Claude Code/ : /Codex/ })
    .click({ timeout: 15_000 });
  await page
    .getByRole("dialog", { name: "新建会话" })
    .getByRole("button", { name: "创建" })
    .click();

  await expect(page).toHaveURL(/\/chat\/[^?]+\?mode=pty/, { timeout: 20_000 });
  const sessionId = new URL(page.url()).hash.match(/\/chat\/([^?]+)/)?.[1];
  expect(sessionId).toBeTruthy();
  await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
  await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
  return sessionId!;
}

async function terminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", sessionId);
}

async function focusTerminalInput(page: Page): Promise<void> {
  const input = page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
}

async function maybeAcceptCodexTrustPrompt(page: Page, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect
      .poll(() => terminalText(page, sessionId), { timeout: 60_000 })
      .toMatch(new RegExp(`${codexReadyPattern.source}|${codexUpdatePromptPattern.source}`, "i"));

    const text = await terminalText(page, sessionId);
    if (!codexUpdatePromptPattern.test(text)) break;

    await focusTerminalInput(page);
    await page.keyboard.press("2");
    await page.keyboard.press("Enter");
  }

  await expect
    .poll(() => terminalText(page, sessionId), { timeout: 60_000 })
    .toMatch(codexReadyPattern);

  const text = await terminalText(page, sessionId);
  if (!/Do you trust/i.test(text)) return;

  await focusTerminalInput(page);
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => terminalText(page, sessionId), { timeout: 60_000 })
    .toMatch(codexReadyPattern);
}

async function maybeAcceptClaudeTrustPrompt(page: Page, sessionId: string): Promise<void> {
  await expect
    .poll(() => terminalText(page, sessionId), { timeout: 60_000 })
    .toMatch(/Quick safety check|Is this a project you trust|Try "write a test"|Welcome back/i);

  const text = await terminalText(page, sessionId);
  if (/Quick safety check|Is this a project you trust/i.test(text)) {
    await focusTerminalInput(page);
    await page.keyboard.press("Enter");
  }

  await expect
    .poll(() => terminalText(page, sessionId), { timeout: 60_000 })
    .toMatch(/Try "write a test"|Welcome back|Claude Code v/i);
}

async function submitCodexPrompt(page: Page, sessionId: string): Promise<void> {
  await page.keyboard.press("Enter");
  const submitted = await expect
    .poll(() => terminalText(page, sessionId), { timeout: 5_000 })
    .toMatch(/Working|Action Required|Would you like to make|Would you like to run/i)
    .then(
      () => true,
      () => false,
    );
  if (submitted) return;

  await page.keyboard.press("Enter");
}

async function triggerToolApproval(
  page: Page,
  sessionId: string,
  provider: Provider,
): Promise<void> {
  if (provider === "claude") {
    await maybeAcceptClaudeTrustPrompt(page, sessionId);
  } else {
    await maybeAcceptCodexTrustPrompt(page, sessionId);
  }

  const filePath = `${smokeCwd.replace(/\/$/, "")}/dev_anywhere_real_approval_${provider}_${Date.now()}.txt`;
  const prompt = [
    `Create the file ${filePath}.`,
    "Write exactly this content: DEV Anywhere approval smoke.",
    "Use the file write/edit tool directly. Do not ask follow-up questions.",
  ].join(" ");

  await focusTerminalInput(page);
  await page.keyboard.type(prompt);
  if (provider === "codex") {
    await submitCodexPrompt(page, sessionId);
  } else {
    await page.keyboard.press("Enter");
  }
}

async function cancelNativeApproval(page: Page, provider: Provider): Promise<void> {
  await focusTerminalInput(page);
  if (provider === "claude") {
    await page.keyboard.press("3");
    await page.keyboard.press("Enter");
    return;
  }

  await page.keyboard.press("Escape");
}

async function terminateSession(page: Page, sessionId: string): Promise<void> {
  await page.goto("/#/sessions");
  const row = page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`);
  if ((await row.count()) === 0) return;

  await row.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await row.locator('[data-slot="session-row-menu-trigger"]').click({ timeout: 5_000 });
  await page.locator('[data-slot="session-row-terminate-item"]').click({ timeout: 5_000 });

  const confirm = page.locator('[data-slot="session-termination-confirm"]');
  if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await confirm.click({ timeout: 2_000 });
  }

  await expect(row).toHaveCount(0, { timeout: 10_000 });
}

async function restartRelayOnly(): Promise<void> {
  await execFileAsync("bash", ["scripts/dev-relay-restart.sh", "--relay-port", relayPort], {
    cwd: repoRoot,
    timeout: 30_000,
    env: process.env,
  });
}

for (const provider of ["claude", "codex"] as const) {
  test(`real ${provider} hosted PTY exposes approval state through server session status`, async ({
    page,
  }) => {
    const sessionId = await createHostedPtySession(page, provider);

    try {
      await triggerToolApproval(page, sessionId, provider);

      await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible({
        timeout: approvalTimeoutMs,
      });
      await expect(
        page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`),
      ).toContainText("等待审批", { timeout: 15_000 });

      await page.reload();
      await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`),
      ).toContainText("等待审批", { timeout: 15_000 });

      await restartRelayOnly();
      await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible({
        timeout: 45_000,
      });
      await expect(
        page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`),
      ).toContainText("等待审批", { timeout: 45_000 });

      await cancelNativeApproval(page, provider);
      await expect(page.locator('[data-slot="pty-approval-hint"]')).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(
        page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`),
      ).not.toContainText("等待审批", { timeout: 60_000 });
    } finally {
      await terminateSession(page, sessionId);
    }
  });
}
