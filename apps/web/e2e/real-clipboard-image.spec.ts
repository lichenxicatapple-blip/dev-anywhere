import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";

const enabled = process.env.DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE === "1";
const relayPort = process.env.DEV_ANYWHERE_RELAY_PORT ?? "3100";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = resolve(repoRoot, "apps/web/e2e/fixtures");
const jsonFixture = resolve(fixtureRoot, "json-worker-chaos-agent.mjs");
const ptyFixture = resolve(fixtureRoot, "local-pty-chaos-agent.mjs");
const smokeRoot =
  process.env.DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_CWD ?? "/tmp/dev-anywhere-chaos/clipboard-image";
const execFileAsync = promisify(execFile);
let previousProxyRuntime: ProxyRuntimeSnapshot | null = null;

type ProxyRuntimeSnapshot = {
  running: boolean;
  envName?: string;
  envNameSource?: string;
  relayUrl?: string;
  relayUrlSource?: string;
};

test.setTimeout(120_000);

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync(command, args, {
    cwd: repoRoot,
    timeout: 45_000,
    env: {
      ...process.env,
      ...env,
      DEV_ANYWHERE_LOG_RUN_ID:
        env.DEV_ANYWHERE_LOG_RUN_ID ??
        `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-clipboard-image`,
    },
  });
}

async function restartRelay(): Promise<void> {
  await run("bash", ["scripts/dev-relay-restart.sh"]);
}

async function ensureProxyInitialized(): Promise<void> {
  await run("pnpm", ["--filter", "@dev-anywhere/proxy", "run", "dev", "--", "init"]);
}

async function readProxyRuntime(): Promise<ProxyRuntimeSnapshot> {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["--filter", "@dev-anywhere/proxy", "run", "dev", "--", "serve", "status"],
    {
      cwd: repoRoot,
      timeout: 10_000,
      env: { ...process.env, INIT_CWD: repoRoot },
    },
  ).catch((err: unknown) => ({ stdout: String(err) }));

  const envMatch = stdout.match(/^Env:\s+(\S+)\s+\(([^)]+)\)/m);
  const relayMatch = stdout.match(/^Config:\s+relay\s+(\S+)\s+\(([^)]+)\)/m);
  return {
    running: stdout.includes("Service: running"),
    ...(envMatch && envMatch[1] !== "single"
      ? { envName: envMatch[1], envNameSource: envMatch[2] }
      : {}),
    ...(relayMatch && relayMatch[1] !== "(unset)"
      ? { relayUrl: relayMatch[1], relayUrlSource: relayMatch[2] }
      : {}),
  };
}

async function restartProxyWithFixtures(): Promise<void> {
  await run("pnpm", ["--filter", "@dev-anywhere/proxy", "run", "dev", "--", "serve", "restart"], {
    INIT_CWD: repoRoot,
    RELAY_URL: `ws://localhost:${relayPort}`,
    CLAUDE_BIN: jsonFixture,
    CODEX_BIN: ptyFixture,
  });
  await waitForProxyRelayConnected();
}

async function restoreProxyServe(): Promise<void> {
  if (process.env.DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_RESTORE === "0") return;
  const previous = previousProxyRuntime;
  if (!previous?.running) {
    await run("pnpm", ["--filter", "@dev-anywhere/proxy", "run", "dev", "--", "serve", "stop"], {
      INIT_CWD: repoRoot,
    }).catch(() => undefined);
    return;
  }

  const restartArgs = [
    "--filter",
    "@dev-anywhere/proxy",
    "run",
    "dev",
    "--",
    "serve",
    "restart",
    ...(previous.envName && previous.envNameSource !== "file" ? ["--env", previous.envName] : []),
  ];
  await run("pnpm", restartArgs, {
    INIT_CWD: repoRoot,
    ...(previous.relayUrl && previous.relayUrlSource === "env"
      ? { RELAY_URL: previous.relayUrl }
      : {}),
  }).catch(() => undefined);
}

async function waitForProxyRelayConnected(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const { stdout } = await execFileAsync(
      "pnpm",
      ["--filter", "@dev-anywhere/proxy", "run", "dev", "--", "serve", "status"],
      {
        cwd: repoRoot,
        timeout: 10_000,
        env: { ...process.env, INIT_CWD: repoRoot },
      },
    ).catch((err: unknown) => ({ stdout: String(err) }));
    if (stdout.includes("Relay:   connected")) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("proxy serve did not connect to relay");
}

async function selectFirstProxy(page: Page): Promise<void> {
  await page.goto("/#/sessions");
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  await expect(switcher).toBeVisible({ timeout: 30_000 });
  await switcher.click();

  const firstProxy = page.locator('[data-slot="proxy-item"][data-online="true"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 30_000 });
  await firstProxy.click();
}

async function createSession(
  page: Page,
  options: { mode: "json" | "pty"; provider?: "claude" | "codex"; cwd: string },
): Promise<string> {
  await selectFirstProxy(page);
  await page.locator('button:has-text("新建会话"):visible').last().click();
  await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
  await page.getByLabel("工作目录").fill(options.cwd);
  await page.getByRole("heading", { name: "新建会话" }).click();

  if (options.mode === "json") {
    await page
      .getByLabel("交互方式")
      .getByRole("button", { name: /聊天模式/ })
      .click();
  } else {
    await page
      .getByLabel("交互方式")
      .getByRole("button", { name: /终端模式/ })
      .click();
  }

  if (options.provider === "codex") {
    await page.getByLabel("Agent CLI").getByRole("button", { name: /Codex/ }).click();
  }

  await page
    .getByRole("dialog", { name: "新建会话" })
    .getByRole("button", { name: "创建" })
    .click();

  await expect(page).toHaveURL(new RegExp(`/chat/[^?]+\\?mode=${options.mode}`), {
    timeout: 30_000,
  });
  const sessionId = new URL(page.url()).hash.match(/\/chat\/([^?]+)/)?.[1];
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function terminateSession(page: Page, sessionId: string): Promise<void> {
  await page.goto("/#/sessions");
  const row = page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`);
  if ((await row.count()) === 0) return;
  await row.locator('[data-slot="session-row-menu-trigger"]').click();
  await page.locator('[data-slot="session-row-terminate-item"]').click();
  await page.locator('[data-slot="session-termination-confirm"]').click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
}

async function dispatchImagePaste(target: Locator): Promise<void> {
  await target.evaluate((node) => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    node.dispatchEvent(event);
  });
}

function clipboardDir(sessionId: string): string {
  return join(homedir(), ".dev-anywhere", "data", sessionId, "clipboard");
}

async function waitForUploadedImage(sessionId: string): Promise<string> {
  const dir = clipboardDir(sessionId);
  for (let i = 0; i < 80; i += 1) {
    if (existsSync(dir)) {
      const file = readdirSync(dir).find((entry) => entry.endsWith(".png"));
      if (file) return join(dir, file);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`uploaded clipboard image not found for ${sessionId}`);
}

function expectUploadedBytes(path: string): void {
  expect([...readFileSync(path)]).toEqual([1, 2, 3]);
}

function cleanupSessionData(sessionId: string): void {
  rmSync(join(homedir(), ".dev-anywhere", "data", sessionId), { recursive: true, force: true });
}

async function terminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", sessionId);
}

function compactTerminalText(text: string): string {
  return text.replace(/\s+/g, "");
}

test.describe("real clipboard image chain", () => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE=1 to run real relay/proxy");

  test.beforeAll(async () => {
    previousProxyRuntime = await readProxyRuntime();
    await restartRelay();
    await ensureProxyInitialized();
    await restartProxyWithFixtures();
  });

  test.afterAll(async () => {
    await restoreProxyServe();
  });

  test("uploads JSON and PTY pasted images through real relay/proxy and writes real files", async ({
    page,
  }) => {
    const jsonCwd = join(smokeRoot, `json-${Date.now()}`);
    const ptyCwd = join(smokeRoot, `pty-${Date.now()}`);
    mkdirSync(jsonCwd, { recursive: true });
    mkdirSync(ptyCwd, { recursive: true });

    let jsonSessionId: string | undefined;
    let ptySessionId: string | undefined;

    try {
      jsonSessionId = await createSession(page, { mode: "json", cwd: jsonCwd });
      await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible({
        timeout: 20_000,
      });
      const input = page.getByLabel("输入聊天消息");
      await input.fill("inspect ");
      await dispatchImagePaste(input);

      const jsonUpload = await waitForUploadedImage(jsonSessionId);
      expectUploadedBytes(jsonUpload);
      await expect(input).toHaveValue(`inspect @${jsonUpload} `);

      ptySessionId = await createSession(page, { mode: "pty", provider: "codex", cwd: ptyCwd });
      await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible({ timeout: 20_000 });
      await dispatchImagePaste(page.locator('[data-slot="pty-terminal"]'));

      const ptyUpload = await waitForUploadedImage(ptySessionId);
      expectUploadedBytes(ptyUpload);
      await expect
        .poll(async () => compactTerminalText(await terminalText(page, ptySessionId!)), {
          timeout: 20_000,
        })
        .toContain(basename(ptyUpload));
    } finally {
      if (jsonSessionId) {
        await terminateSession(page, jsonSessionId).catch(() => undefined);
        cleanupSessionData(jsonSessionId);
      }
      if (ptySessionId) {
        await terminateSession(page, ptySessionId).catch(() => undefined);
        cleanupSessionData(ptySessionId);
      }
    }
  });
});
