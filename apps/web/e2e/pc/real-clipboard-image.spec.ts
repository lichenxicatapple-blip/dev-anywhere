import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";

const enabled = process.env.DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE === "1";
const relayPort = "3100";
const proxyProfile = "local";
const proxyRelay = "local";
const proxyName = "DEV Anywhere Clipboard Smoke";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixtureRoot = resolve(repoRoot, "apps/web/e2e/fixtures");
const jsonFixture = resolve(fixtureRoot, "json-worker-chaos-agent.mjs");
const ptyFixture = resolve(fixtureRoot, "local-pty-chaos-agent.mjs");
const smokeRoot =
  process.env.DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_CWD ?? "/tmp/dev-anywhere-chaos/clipboard-image";
const execFileAsync = promisify(execFile);
const pngBytes = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239,
  191, 167, 219, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

test.setTimeout(120_000);

type ImagePasteDispatchResult = {
  defaultPrevented: boolean;
  canceled: boolean;
};

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync(command, args, {
    cwd: repoRoot,
    timeout: 45_000,
    env: { ...process.env, ...env },
  });
}

async function restartRelay(): Promise<void> {
  await run("bash", ["scripts/dev-relay-restart.sh", "--relay-port", relayPort]);
}

async function ensureProxyInitialized(): Promise<void> {
  await run("pnpm", ["--filter", "@dev-anywhere/proxy", "run", "dev", "--", "init"]);
}

async function restartProxyWithFixtures(): Promise<void> {
  await run(
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
      INIT_CWD: repoRoot,
      DEV_ANYWHERE_PROXY_NAME: proxyName,
      CLAUDE_BIN: jsonFixture,
      CODEX_BIN: ptyFixture,
    },
  );
  await waitForProxyRelayConnected();
}

async function restartNormalProxyProfile(): Promise<void> {
  await run(
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
    { INIT_CWD: repoRoot },
  );
}

async function waitForProxyRelayConnected(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const { stdout } = await execFileAsync(
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
        "status",
      ],
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

  const proxy = page
    .locator('[data-slot="proxy-item"][data-online="true"]:visible')
    .filter({ hasText: proxyName });
  await expect(proxy).toBeVisible({ timeout: 30_000 });
  await proxy.click();
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

async function dispatchImagePaste(target: Locator): Promise<ImagePasteDispatchResult> {
  return target.evaluate((node, bytes) => {
    const file = new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    const canceled = !node.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      canceled,
    };
  }, pngBytes);
}

function activePtyEntry(page: Page, sessionId: string): Locator {
  return page.locator(
    `[data-slot="pty-keepalive-entry"][data-session-id="${sessionId}"][data-active="true"]`,
  );
}

async function expectActivePtyReady(page: Page, sessionId: string): Promise<Locator> {
  const entry = activePtyEntry(page, sessionId);
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await expect(entry.locator('[data-slot="chat-pty-view"]')).toBeVisible({ timeout: 20_000 });
  await expect(entry.locator('[data-slot="pty-host"] .xterm')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () =>
        entry.locator('[data-slot="pty-host"]').evaluate((host) => {
          const screen = host.querySelector<HTMLElement>(".xterm-screen");
          const textarea = host.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Terminal input"]',
          );
          if (!screen || !textarea) return false;
          return screen.clientWidth > 0 && screen.clientHeight > 0;
        }),
      { timeout: 20_000 },
    )
    .toBeTruthy();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = (
            window as typeof window & {
              __devAnywhereRelayRuntime?: {
                wsManagerRef?: { isConnected?: () => boolean } | null;
                relayClientRef?: { getBoundProxyId?: () => string | null } | null;
              };
            }
          ).__devAnywhereRelayRuntime;
          return {
            connected: Boolean(runtime?.wsManagerRef?.isConnected?.()),
            boundProxyId: runtime?.relayClientRef?.getBoundProxyId?.() ?? null,
          };
        }),
      { timeout: 20_000 },
    )
    .toEqual(
      expect.objectContaining({
        connected: true,
        boundProxyId: expect.any(String),
      }),
    );
  return entry;
}

function proxyDataRoot(): string {
  return join(homedir(), ".dev-anywhere", "profiles", proxyProfile, "data");
}

// 上传文件统一落 os.tmpdir()/dev-anywhere/, 平铺单层, 跟 sessionId 解耦, 跟 user
// repo .gitignore 完全脱钩 (commit 55ad4c4f)。spec 用 snapshot 前后 diff 找新文件。
function uploadRoot(): string {
  return join(tmpdir(), "dev-anywhere");
}

function snapshotUploadRoot(): Set<string> {
  const root = uploadRoot();
  if (!existsSync(root)) return new Set();
  return new Set(readdirSync(root));
}

async function waitForNewUploadedFile(
  before: Set<string>,
  prefix: string,
  ext: string,
): Promise<string> {
  const root = uploadRoot();
  for (let i = 0; i < 80; i += 1) {
    if (existsSync(root)) {
      const fresh = readdirSync(root).find(
        (entry) => !before.has(entry) && entry.startsWith(prefix) && entry.endsWith(ext),
      );
      if (fresh) return join(root, fresh);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`uploaded ${prefix}*${ext} not found under ${root}`);
}

function expectUploadedBytes(path: string, expected: number[] | Buffer): void {
  expect([...readFileSync(path)]).toEqual([...expected]);
}

function cleanupSessionData(sessionId: string): void {
  rmSync(join(proxyDataRoot(), sessionId), { recursive: true, force: true });
}

function cleanupUploadedFile(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}

async function terminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", sessionId);
}

function compactTerminalText(text: string): string {
  return text.replace(/\s+/g, "");
}

async function previewJsonImagePath(page: Page, imagePath: string): Promise<void> {
  await page.locator('[data-slot="send-button"][data-variant="send"]').click();
  await expect(page.locator('[data-slot="image-preview-links"]')).toHaveCount(0);
  const previewLink = page
    .locator('[data-slot="inline-image-preview-link"]', { hasText: imagePath })
    .first();
  await expect(previewLink).toBeVisible({ timeout: 20_000 });
  await previewLink.click();
  await expect(page.locator('[data-slot="image-preview-dialog"]')).toBeVisible();
  await expect(page.locator('[data-slot="image-preview-img"]')).toHaveAttribute(
    "data-loaded",
    "true",
    { timeout: 20_000 },
  );
  await expect(page.locator('[data-slot="image-preview-meta"]')).toContainText("image/png");
  await page.keyboard.press("Escape");
}

test.describe("real clipboard image chain", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE=1 to run real relay/proxy");

  test.beforeAll(async () => {
    await restartRelay();
    await ensureProxyInitialized();
    await restartProxyWithFixtures();
  });

  test.afterAll(async () => {
    await restartNormalProxyProfile().catch(() => undefined);
  });

  test("uploads JSON and PTY pasted images through real relay/proxy and writes real files", async ({
    page,
  }) => {
    const jsonCwd = join(smokeRoot, `json-${Date.now()}`);
    const ptyCwd = join(smokeRoot, `pty-${Date.now()}`);
    mkdirSync(jsonCwd, { recursive: true });
    mkdirSync(ptyCwd, { recursive: true });
    writeFileSync(join(jsonCwd, ".gitignore"), "node_modules/\n");
    writeFileSync(join(ptyCwd, ".gitignore"), "node_modules/\n");

    let jsonSessionId: string | undefined;
    let ptySessionId: string | undefined;
    let jsonUpload: string | undefined;
    let ptyUpload: string | undefined;

    try {
      jsonSessionId = await createSession(page, { mode: "json", cwd: jsonCwd });
      await expect(page.locator('[data-slot="input-bar"][data-mode="json"]')).toBeVisible({
        timeout: 20_000,
      });
      const input = page.getByLabel("输入聊天消息");
      await input.fill("inspect ");
      const jsonBefore = snapshotUploadRoot();
      expect(await dispatchImagePaste(input)).toMatchObject({ defaultPrevented: true });

      jsonUpload = await waitForNewUploadedFile(jsonBefore, "paste-", ".png");
      expectUploadedBytes(jsonUpload, pngBytes);
      // 文件落 tmp 绝对路径, 不再相对 cwd, 不再追加 user .gitignore (commit 55ad4c4f)。
      await expect(input).toHaveValue(`inspect @${jsonUpload} `);
      await previewJsonImagePath(page, jsonUpload);

      ptySessionId = await createSession(page, { mode: "pty", provider: "codex", cwd: ptyCwd });
      await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible({ timeout: 20_000 });
      const ptyEntry = await expectActivePtyReady(page, ptySessionId);
      const ptyTerminal = ptyEntry.locator('[data-slot="pty-terminal"]');
      await ptyTerminal.click();
      const ptyBefore = snapshotUploadRoot();
      expect(await dispatchImagePaste(ptyTerminal)).toMatchObject({ defaultPrevented: true });

      ptyUpload = await waitForNewUploadedFile(ptyBefore, "paste-", ".png");
      expectUploadedBytes(ptyUpload, pngBytes);
      const visiblePtyNameFragment = basename(ptyUpload).split("-").at(-1) ?? basename(ptyUpload);
      await expect
        .poll(async () => compactTerminalText(await terminalText(page, ptySessionId!)), {
          timeout: 20_000,
        })
        .toContain(visiblePtyNameFragment);
    } finally {
      cleanupUploadedFile(jsonUpload);
      cleanupUploadedFile(ptyUpload);
      if (jsonSessionId) {
        await terminateSession(page, jsonSessionId).catch(() => undefined);
        cleanupSessionData(jsonSessionId);
      }
      rmSync(jsonCwd, { recursive: true, force: true });
      if (ptySessionId) {
        await terminateSession(page, ptySessionId).catch(() => undefined);
        cleanupSessionData(ptySessionId);
      }
      rmSync(ptyCwd, { recursive: true, force: true });
    }
  });

  test("PTY chat menu uploads picked file and inserts the @<path> token", async ({ page }) => {
    const ptyCwd = join(smokeRoot, `pty-file-${Date.now()}`);
    mkdirSync(ptyCwd, { recursive: true });
    writeFileSync(join(ptyCwd, ".gitignore"), "node_modules/\n");
    let ptySessionId: string | undefined;
    let uploadedAbs: string | undefined;
    try {
      ptySessionId = await createSession(page, { mode: "pty", provider: "codex", cwd: ptyCwd });
      await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible({ timeout: 20_000 });

      // setInputFiles 直接打到 hidden input,绕过 Radix Portal 在 e2e 下的 pointer 不稳定。
      // 真实链路: input.change → fileToUploadPayload → relay.uploadFile → proxy 落盘 → "@<path> " sendRaw。
      const fileBytes = Buffer.from("hello dev-anywhere\n", "utf-8");
      const fileName = `notes-${Date.now()}.txt`;
      const before = snapshotUploadRoot();
      await page
        .locator('input[data-slot="chat-menu-upload-file-input"]')
        .setInputFiles({ name: fileName, mimeType: "text/plain", buffer: fileBytes });

      // 文件落 os.tmpdir()/dev-anywhere/up-<6 nanoid>.txt (commit 55ad4c4f)。
      uploadedAbs = await waitForNewUploadedFile(before, "up-", ".txt");
      expectUploadedBytes(uploadedAbs, fileBytes);

      // 等到 xterm 回放出 @<path>, 证明终端 stdin 收到了 mention 文本
      await expect
        .poll(async () => compactTerminalText(await terminalText(page, ptySessionId!)), {
          timeout: 20_000,
        })
        .toContain(`@${uploadedAbs}`.replace(/\s+/g, ""));
    } finally {
      cleanupUploadedFile(uploadedAbs);
      if (ptySessionId) {
        await terminateSession(page, ptySessionId).catch(() => undefined);
        cleanupSessionData(ptySessionId);
      }
      rmSync(ptyCwd, { recursive: true, force: true });
    }
  });
});
