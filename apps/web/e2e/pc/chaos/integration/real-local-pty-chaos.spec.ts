import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
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
const requireProxy = createRequire(resolve(repoRoot, "apps/proxy/package.json"));
const proxyEntry = resolve(repoRoot, "apps/proxy/src/index.ts");

test.setTimeout(120_000);

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();

  const firstProxy = page.locator('[data-slot="proxy-item"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 15_000 });
  await firstProxy.click();
  await expect(switcher).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  // Closing the popover restores focus after its exit animation and unmount.
  // Let that finish before opening the terminal and sending keyboard input.
  await expect(switcher).toBeFocused();
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

function startLocalRuntime(cwd: string, config: E2EBackendConfig) {
  if (!chaosBin) throw new Error("DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN is required");
  // Own the actual terminal in the test worker. macOS screen can return success
  // without creating a session when the test runs under a background service.
  const terminal = requireProxy("node-pty").spawn(
    process.execPath,
    [requireProxy.resolve("tsx/cli"), proxyEntry, "--profile", config.profile, provider],
    {
      cwd: repoRoot,
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      env: {
        ...process.env,
        DEV_ANYWHERE_CWD: cwd,
        [provider === "codex" ? "CODEX_BIN" : "CLAUDE_BIN"]: chaosBin,
      },
    },
  );
  let output = "";
  let exited = false;
  const data = terminal.onData((chunk: string) => {
    output = (output + chunk).slice(-32_768);
  });
  const exit = terminal.onExit(() => {
    exited = true;
  });
  return {
    output: () => output,
    stop: async () => {
      try {
        if (!exited) terminal.kill();
        await expect.poll(() => exited, { timeout: 5000 }).toBe(true);
      } catch (error) {
        if (!exited) terminal.kill("SIGKILL");
        throw error;
      } finally {
        data.dispose();
        exit.dispose();
      }
    },
  };
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
  }, testInfo) => {
    test.skip(
      !enabled,
      "integration chaos: 需要 `pnpm dev:chaos` 编排起 local PTY runtime 并注入 chaos provider (DEV_ANYWHERE_LOCAL_PTY_CHAOS=1 + DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN)",
    );
    test.skip(!chaosBin, "DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN missing");
    const backendConfig = requireE2EBackendConfig();
    const frames: Record<string, unknown>[] = [];
    const enterEvents: Record<string, unknown>[] = [];
    const enterPrefix = "local-pty-chaos-enter:";
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        try {
          const message = JSON.parse(String(payload));
          if (message.type !== "remote_input_raw") return;
          frames.push({
            time: Date.now(),
            sessionId: message.sessionId,
            data: String(message.data).slice(0, 512),
            traceId: message.traceId,
          });
          if (frames.length > 100) frames.shift();
        } catch {
          // Binary PTY output and unrelated frames are not input evidence.
        }
      });
    });
    page.on("console", (message) => {
      const text = message.text();
      if (!text.startsWith(enterPrefix)) return;
      enterEvents.push(JSON.parse(text.slice(enterPrefix.length)));
      if (enterEvents.length > 100) enterEvents.shift();
    });
    await page.addInitScript((prefix) => {
      localStorage.setItem("dev_anywhere_pty_input_latency_trace", "1");
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Enter") return;
          const target = event.target instanceof Element ? event.target : null;
          const ready = (): string | null =>
            document
              .querySelector('[data-slot="chat-pty-view"]')
              ?.getAttribute("data-connection-ready") ?? null;
          const before = {
            time: Date.now(),
            target: target?.outerHTML.slice(0, 512),
            connectionReady: ready(),
            isComposing: event.isComposing,
          };
          // A timer runs after all key handlers, including handlers that stop propagation.
          setTimeout(() => {
            console.debug(
              prefix +
                JSON.stringify({
                  ...before,
                  defaultPrevented: event.defaultPrevented,
                  finalConnectionReady: ready(),
                }),
            );
          }, 0);
        },
        true,
      );
    }, enterPrefix);

    const uniqueName = `dev-anywhere-local-pty-${provider}-${Date.now()}`;
    const cwd = `${chaosRoot.replace(/\/$/, "")}/${uniqueName}`;
    mkdirSync(cwd, { recursive: true });
    const runtime = await test.step("start local terminal runtime", () =>
      startLocalRuntime(cwd, backendConfig));

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
    } catch (error) {
      try {
        const latency = await page.evaluate(() => {
          const tracedWindow = window as Window & {
            __devAnywherePtyInputLatencyTrace?: unknown[];
          };
          return (tracedWindow.__devAnywherePtyInputLatencyTrace ?? []).slice(-100);
        });
        await testInfo.attach("local-pty-input-evidence", {
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({ frames, enterEvents, latency }, null, 2)),
        });
        console.error(
          "Local PTY input failure:",
          JSON.stringify({
            sentFrames: frames.length,
            lastFrames: frames.slice(-8),
            enterEvents,
            latencyTail: latency.slice(-8),
          }),
        );
      } catch (diagnosticError) {
        console.error("Could not capture local PTY input evidence:", String(diagnosticError));
      }
      throw error;
    } finally {
      try {
        await runtime.stop();
      } finally {
        await testInfo.attach("local-terminal-output", {
          contentType: "text/plain",
          body: Buffer.from(runtime.output()),
        });
      }
    }
  });
});
