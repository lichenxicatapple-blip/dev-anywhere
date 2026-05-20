import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

type Provider = "claude" | "codex";

const smokeCwd =
  process.env.DEV_ANYWHERE_REAL_PROVIDER_CWD ?? "/tmp/dev-anywhere-chaos/provider-approval";
const approvalTimeoutMs = Number(
  process.env.DEV_ANYWHERE_REAL_PROVIDER_APPROVAL_TIMEOUT_MS ?? 60_000,
);
const relayPort = "3100";
const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const codexReadyPattern = /Do you trust|Ready|Find and fix a bug|OpenAI Codex|Run \/review/i;
const codexUpdatePromptPattern =
  /Update available|Skip until next version|Press enter to continue/i;
const diagnosticTextLimit = 40_000;

test.describe.configure({ mode: "serial" });
test.setTimeout(approvalTimeoutMs + 60_000);

// 需要本机已登录的 Claude/Codex CLI 才能验证 hosted PTY approval 路径——不是 hermetic 环境
// 能保证的契约。CI / 普通本地跑 e2e 时缺省跳过,显式 opt-in 才走:
//   DEV_ANYWHERE_REAL_PROVIDER_APPROVAL=1 bash scripts/web-e2e.sh e2e/real-provider-approval.spec.ts --project=desktop
const realProviderEnabled = process.env.DEV_ANYWHERE_REAL_PROVIDER_APPROVAL === "1";
test.skip(
  !realProviderEnabled,
  "set DEV_ANYWHERE_REAL_PROVIDER_APPROVAL=1 to run against locally authed CLI",
);

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

async function choosePermissionMode(page: Page, label: string): Promise<void> {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: label }).click();
}

async function createHostedPtySession(
  page: Page,
  provider: Provider,
  permissionModeLabel?: string,
): Promise<string> {
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
  if (permissionModeLabel) {
    await choosePermissionMode(page, permissionModeLabel);
  }
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

async function createJsonSession(page: Page, permissionModeLabel?: string): Promise<string> {
  await page.goto("/#/sessions");
  await selectFirstProxy(page);

  await page.locator('button:has-text("新建会话"):visible').last().click();
  await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
  await page.getByLabel("工作目录").fill(smokeCwd);
  await page.getByRole("heading", { name: "新建会话" }).click();
  await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toHaveCount(0);
  await page
    .getByLabel("交互方式")
    .getByRole("button", { name: /聊天模式/ })
    .click({ timeout: 15_000 });
  if (permissionModeLabel) {
    await choosePermissionMode(page, permissionModeLabel);
  }
  await page
    .getByRole("dialog", { name: "新建会话" })
    .getByRole("button", { name: "创建" })
    .click();

  await expect(page).toHaveURL(/\/chat\/[^?]+\?mode=json/, { timeout: 20_000 });
  const sessionId = new URL(page.url()).hash.match(/\/chat\/([^?]+)/)?.[1];
  expect(sessionId).toBeTruthy();
  await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible();
  return sessionId!;
}

async function terminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", sessionId);
}

function diagnosticName(label: string): string {
  return label
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function tailDiagnosticText(text: string): string {
  if (text.length <= diagnosticTextLimit) return text;
  return `[truncated ${text.length - diagnosticTextLimit} chars]\n${text.slice(-diagnosticTextLimit)}`;
}

async function attachTextDiagnostic(testInfo: TestInfo, name: string, body: string): Promise<void> {
  const filename = `${diagnosticName(name)}.txt`;
  const path = testInfo.outputPath(filename);
  writeFileSync(path, tailDiagnosticText(body));
  await testInfo.attach(filename, {
    path,
    contentType: "text/plain",
  });
}

async function attachPngDiagnostic(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const filename = `${diagnosticName(name)}.png`;
  const path = testInfo.outputPath(filename);
  writeFileSync(path, body);
  await testInfo.attach(filename, {
    path,
    contentType: "image/png",
  });
}

async function attachPageDiagnostics(testInfo: TestInfo, page: Page, label: string): Promise<void> {
  const name = diagnosticName(label);
  const metadata = {
    url: page.url(),
    sessionRows: await page
      .locator('[data-slot="session-row"]')
      .evaluateAll((rows) =>
        rows.map((row) => ({
          id: row.getAttribute("data-session-id"),
          text: row.textContent?.trim() ?? "",
        })),
      )
      .catch((error) => [{ error: String(error) }]),
    toolApprovalCards: await page
      .locator('[data-slot="tool-approval-card"]')
      .evaluateAll((cards) =>
        cards.map((card) => ({
          status: card.getAttribute("data-status"),
          text: card.textContent?.trim() ?? "",
        })),
      )
      .catch((error) => [{ error: String(error) }]),
    ptyApprovalHintCount: await page
      .locator('[data-slot="pty-approval-hint"]')
      .count()
      .catch(() => -1),
  };
  await attachTextDiagnostic(testInfo, `${name}-metadata`, JSON.stringify(metadata, null, 2));
  await attachTextDiagnostic(
    testInfo,
    `${name}-body`,
    await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch((error) => `failed to read body text: ${String(error)}`),
  );
  await attachPngDiagnostic(
    testInfo,
    `${name}-screenshot`,
    await page.screenshot({ fullPage: true }),
  );
}

async function attachPtyDiagnostics(
  testInfo: TestInfo,
  page: Page,
  sessionId: string,
  label: string,
): Promise<void> {
  await attachPageDiagnostics(testInfo, page, label);
  await attachTextDiagnostic(
    testInfo,
    `${label}-terminal`,
    await terminalText(page, sessionId).catch(
      (error) => `failed to read terminal: ${String(error)}`,
    ),
  );

  const ptyView = page.locator('[data-slot="chat-pty-view"]');
  if (await ptyView.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await attachPngDiagnostic(testInfo, `${label}-pty`, await ptyView.screenshot());
  }
}

async function tryAttachPageDiagnostics(
  testInfo: TestInfo,
  page: Page,
  label: string,
): Promise<void> {
  try {
    await attachPageDiagnostics(testInfo, page, label);
  } catch (error) {
    await testInfo
      .attach(`${diagnosticName(label)}-diagnostic-error.txt`, {
        body: String(error),
        contentType: "text/plain",
      })
      .catch(() => undefined);
  }
}

async function tryAttachPtyDiagnostics(
  testInfo: TestInfo,
  page: Page,
  sessionId: string,
  label: string,
): Promise<void> {
  try {
    await attachPtyDiagnostics(testInfo, page, sessionId, label);
  } catch (error) {
    await testInfo
      .attach(`${diagnosticName(label)}-diagnostic-error.txt`, {
        body: String(error),
        contentType: "text/plain",
      })
      .catch(() => undefined);
  }
}

async function focusTerminalInput(page: Page): Promise<void> {
  const input = page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
}

async function sendJsonMessage(page: Page, text: string): Promise<void> {
  const textbox = page.getByLabel("输入聊天消息");
  await expect(textbox).toBeVisible({ timeout: 15_000 });
  await textbox.fill(text);
  await page.keyboard.press("Enter");
}

function sessionRow(page: Page, sessionId: string) {
  return page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`);
}

function createFilePrompt(filePath: string, content: string): string {
  return [
    `Create the file ${filePath}.`,
    `Write exactly this content: ${content}`,
    "Use the file write/edit tool directly. Do not ask follow-up questions.",
  ].join(" ");
}

async function sendJsonFileCreatePrompt(
  page: Page,
  filePath: string,
  content: string,
): Promise<void> {
  await sendJsonMessage(page, createFilePrompt(filePath, content));
}

async function expectJsonFileCreatedWithoutApproval(
  page: Page,
  sessionId: string,
  filePath: string,
): Promise<void> {
  await expect.poll(() => existsSync(filePath), { timeout: approvalTimeoutMs }).toBe(true);
  await expect(page.locator('[data-slot="tool-approval-card"][data-status="pending"]')).toHaveCount(
    0,
  );
  await expect(sessionRow(page, sessionId)).not.toContainText("等待审批");
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
  filePath = `${smokeCwd.replace(/\/$/, "")}/dev_anywhere_real_approval_${provider}_${Date.now()}.txt`,
): Promise<string> {
  if (provider === "claude") {
    await maybeAcceptClaudeTrustPrompt(page, sessionId);
  } else {
    await maybeAcceptCodexTrustPrompt(page, sessionId);
  }

  const prompt = [createFilePrompt(filePath, "DEV Anywhere approval smoke.")].join(" ");

  await focusTerminalInput(page);
  await page.keyboard.type(prompt);
  if (provider === "codex") {
    await submitCodexPrompt(page, sessionId);
  } else {
    await page.keyboard.press("Enter");
  }
  return filePath;
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
  await execFileAsync("bash", ["scripts/dev/relay-restart.sh", "--relay-port", relayPort], {
    cwd: repoRoot,
    timeout: 30_000,
    env: process.env,
  });
}

for (const provider of ["claude", "codex"] as const) {
  test(`real ${provider} hosted PTY exposes approval state through server session status`, async ({
    page,
  }, testInfo) => {
    let sessionId: string | null = null;

    try {
      sessionId = await createHostedPtySession(page, provider);
      await triggerToolApproval(page, sessionId, provider);

      await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible({
        timeout: approvalTimeoutMs,
      });
      await expect(sessionRow(page, sessionId)).toContainText("等待审批", { timeout: 15_000 });

      await page.reload();
      await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible({
        timeout: 30_000,
      });
      await expect(sessionRow(page, sessionId)).toContainText("等待审批", { timeout: 15_000 });

      await restartRelayOnly();
      await expect(page.locator('[data-slot="pty-approval-hint"]')).toBeVisible({
        timeout: 45_000,
      });
      await expect(sessionRow(page, sessionId)).toContainText("等待审批", { timeout: 45_000 });

      await cancelNativeApproval(page, provider);
      await expect(page.locator('[data-slot="pty-approval-hint"]')).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(sessionRow(page, sessionId)).not.toContainText("等待审批", { timeout: 60_000 });
    } catch (error) {
      if (sessionId) {
        await tryAttachPtyDiagnostics(testInfo, page, sessionId, `${provider}-pty-strict-failure`);
      } else {
        await tryAttachPageDiagnostics(testInfo, page, `${provider}-pty-create-failure`);
      }
      throw error;
    } finally {
      if (sessionId) await terminateSession(page, sessionId);
    }
  });

  test(`real ${provider} hosted PTY bypass mode executes without approval UI`, async ({
    page,
  }, testInfo) => {
    let sessionId: string | null = null;
    const filePath = `${smokeCwd.replace(/\/$/, "")}/dev_anywhere_real_bypass_${provider}_${Date.now()}.txt`;

    try {
      sessionId = await createHostedPtySession(page, provider, "跳过全部审批");
      await triggerToolApproval(page, sessionId, provider, filePath);

      await expect.poll(() => existsSync(filePath), { timeout: approvalTimeoutMs }).toBe(true);
      await expect(page.locator('[data-slot="pty-approval-hint"]')).toHaveCount(0);
      await expect(sessionRow(page, sessionId)).not.toContainText("等待审批");
    } catch (error) {
      if (sessionId) {
        await tryAttachPtyDiagnostics(testInfo, page, sessionId, `${provider}-pty-bypass-failure`);
      } else {
        await tryAttachPageDiagnostics(testInfo, page, `${provider}-pty-bypass-create-failure`);
      }
      throw error;
    } finally {
      rmSync(filePath, { force: true });
      if (sessionId) await terminateSession(page, sessionId);
    }
  });
}

test("real Claude JSON strict mode surfaces a tool approval card", async ({ page }, testInfo) => {
  let sessionId: string | null = null;
  const filePath = `${smokeCwd.replace(/\/$/, "")}/dev_anywhere_real_json_strict_${Date.now()}.txt`;

  try {
    sessionId = await createJsonSession(page, "严格审批");
    await sendJsonFileCreatePrompt(page, filePath, "DEV Anywhere JSON strict approval smoke.");

    await expect(
      page.locator('[data-slot="tool-approval-card"][data-status="pending"]'),
    ).toBeVisible({ timeout: approvalTimeoutMs });
    await expect(sessionRow(page, sessionId)).toContainText("等待审批", { timeout: 15_000 });
  } catch (error) {
    await tryAttachPageDiagnostics(testInfo, page, "claude-json-strict-failure");
    throw error;
  } finally {
    rmSync(filePath, { force: true });
    if (sessionId) await terminateSession(page, sessionId);
  }
});

test("real Claude JSON bypass mode executes without a tool approval card", async ({
  page,
}, testInfo) => {
  let sessionId: string | null = null;
  const filePath = `${smokeCwd.replace(/\/$/, "")}/dev_anywhere_real_json_bypass_${Date.now()}.txt`;

  try {
    sessionId = await createJsonSession(page, "跳过全部审批");
    await sendJsonFileCreatePrompt(page, filePath, "DEV Anywhere JSON bypass approval smoke.");

    await expectJsonFileCreatedWithoutApproval(page, sessionId, filePath);
  } catch (error) {
    await tryAttachPageDiagnostics(testInfo, page, "claude-json-bypass-failure");
    throw error;
  } finally {
    rmSync(filePath, { force: true });
    if (sessionId) await terminateSession(page, sessionId);
  }
});

test("real Claude JSON acceptEdits mode accepts file edits without approval", async ({
  page,
}, testInfo) => {
  let sessionId: string | null = null;
  const filePath = `${smokeCwd.replace(/\/$/, "")}/dev_anywhere_real_json_accept_edits_${Date.now()}.txt`;

  try {
    sessionId = await createJsonSession(page, "自动接受编辑");
    await sendJsonFileCreatePrompt(page, filePath, "DEV Anywhere JSON acceptEdits approval smoke.");

    await expectJsonFileCreatedWithoutApproval(page, sessionId, filePath);
  } catch (error) {
    await tryAttachPageDiagnostics(testInfo, page, "claude-json-accept-edits-failure");
    throw error;
  } finally {
    rmSync(filePath, { force: true });
    if (sessionId) await terminateSession(page, sessionId);
  }
});

test("real Claude JSON plan mode denies tool execution without approval", async ({
  page,
}, testInfo) => {
  let sessionId: string | null = null;
  const filePath = `${smokeCwd.replace(/\/$/, "")}/dev_anywhere_real_json_plan_${Date.now()}.txt`;

  try {
    sessionId = await createJsonSession(page, "只读规划");
    await sendJsonFileCreatePrompt(page, filePath, "DEV Anywhere JSON plan approval smoke.");

    await expect(sessionRow(page, sessionId)).toContainText("空闲", {
      timeout: approvalTimeoutMs,
    });
    expect(existsSync(filePath)).toBe(false);
    await expect(
      page.locator('[data-slot="tool-approval-card"][data-status="pending"]'),
    ).toHaveCount(0);
    await expect(sessionRow(page, sessionId)).not.toContainText("等待审批");
  } catch (error) {
    await tryAttachPageDiagnostics(testInfo, page, "claude-json-plan-failure");
    throw error;
  } finally {
    rmSync(filePath, { force: true });
    if (sessionId) await terminateSession(page, sessionId);
  }
});

test("real Claude JSON auto mode reaches a concrete provider decision", async ({
  page,
}, testInfo) => {
  let sessionId: string | null = null;
  const filePath = `${smokeCwd.replace(/\/$/, "")}/dev_anywhere_real_json_auto_${Date.now()}.txt`;

  try {
    sessionId = await createJsonSession(page, "自动判定");
    await sendJsonFileCreatePrompt(page, filePath, "DEV Anywhere JSON auto approval smoke.");

    const outcome = await expect
      .poll(
        async () => {
          if (existsSync(filePath)) return "created";
          if (
            (await page
              .locator('[data-slot="tool-approval-card"][data-status="pending"]')
              .count()) > 0
          ) {
            return "approval";
          }
          return "pending";
        },
        { timeout: approvalTimeoutMs },
      )
      .toMatch(/^(created|approval)$/)
      .then(async () => {
        if (existsSync(filePath)) return "created";
        return (await page
          .locator('[data-slot="tool-approval-card"][data-status="pending"]')
          .count()) > 0
          ? "approval"
          : "pending";
      });

    if (outcome === "created") {
      await expect(sessionRow(page, sessionId)).not.toContainText("等待审批");
    } else {
      await expect(sessionRow(page, sessionId)).toContainText("等待审批", {
        timeout: 15_000,
      });
    }
  } catch (error) {
    await tryAttachPageDiagnostics(testInfo, page, "claude-json-auto-failure");
    throw error;
  } finally {
    rmSync(filePath, { force: true });
    if (sessionId) await terminateSession(page, sessionId);
  }
});
