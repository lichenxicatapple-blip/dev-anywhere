import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.DEV_ANYWHERE_JSON_WORKER_CHAOS === "1";
const chaosRoot =
  process.env.DEV_ANYWHERE_JSON_WORKER_CHAOS_CWD ?? "/tmp/dev-anywhere-chaos/json-worker";
const relayPort = "3100";
const proxyProfile = "local";
const proxyRelay = "local";
const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

async function selectFirstProxy(page: Page): Promise<void> {
  const switcher = page.locator('[data-slot="proxy-switcher-trigger"]').first();
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();

  const firstProxy = page.locator('[data-slot="proxy-item"]:visible').first();
  await expect(firstProxy).toBeVisible({ timeout: 15_000 });
  await firstProxy.click();
}

async function restartRelayOnly(): Promise<void> {
  await execFileAsync("bash", ["scripts/dev-relay-restart.sh", "--relay-port", relayPort], {
    cwd: repoRoot,
    timeout: 30_000,
    env: process.env,
  });
}

async function restartProxyServeWithFixture(): Promise<void> {
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
      env: {
        ...process.env,
        INIT_CWD: repoRoot,
        CLAUDE_BIN: resolve(repoRoot, "apps/web/e2e/fixtures/json-worker-chaos-agent.mjs"),
      },
    },
  );
}

async function createJsonSession(page: Page, cwd: string): Promise<string> {
  await page.goto("/#/sessions");
  await selectFirstProxy(page);

  await page.locator('button:has-text("新建会话"):visible').last().click();
  await expect(page.getByRole("heading", { name: "新建会话" })).toBeVisible();
  await page.getByLabel("工作目录").fill(cwd);
  await page.getByRole("heading", { name: "新建会话" }).click();
  await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toHaveCount(0);
  await page
    .getByLabel("交互方式")
    .getByRole("button", { name: /聊天模式/ })
    .click({ timeout: 15_000 });
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

async function sendJsonMessage(page: Page, text: string): Promise<void> {
  const textbox = page.getByLabel("输入聊天消息");
  await expect(textbox).toBeVisible({ timeout: 10_000 });
  await textbox.fill(text);
  await page.keyboard.press("Enter");
}

async function expectPendingApprovalCount(
  page: Page,
  count: number,
  timeout = 15_000,
): Promise<void> {
  await expect(page.locator('[data-slot="tool-approval-card"][data-status="pending"]')).toHaveCount(
    count,
    { timeout },
  );
}

function waitForRelayMessage<T extends Record<string, unknown>>(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => msg is T,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("relay message timeout"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };

    ws.addEventListener("message", onMessage);
  });
}

async function terminateSessionByControl(sessionId: string): Promise<void> {
  const ws = new WebSocket(`ws://localhost:${relayPort}/client`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("relay websocket failed")), {
      once: true,
    });
  });

  try {
    const listRequestId = `cleanup-list-${Date.now()}`;
    ws.send(JSON.stringify({ type: "proxy_list_request", requestId: listRequestId }));
    const list = await waitForRelayMessage<{
      type: "proxy_list_response";
      proxies: Array<{ proxyId: string; online: boolean }>;
    }>(
      ws,
      (
        msg,
      ): msg is {
        type: "proxy_list_response";
        proxies: Array<{ proxyId: string; online: boolean }>;
      } =>
        msg.type === "proxy_list_response" &&
        msg.requestId === listRequestId &&
        Array.isArray(msg.proxies),
    );
    const proxyId = list.proxies.find((proxy) => proxy.online)?.proxyId;
    if (!proxyId) throw new Error("no online proxy for cleanup");

    const selectRequestId = `cleanup-select-${Date.now()}`;
    ws.send(JSON.stringify({ type: "proxy_select", requestId: selectRequestId, proxyId }));
    await waitForRelayMessage(
      ws,
      (msg): msg is { type: "proxy_select_response"; success: boolean } =>
        msg.type === "proxy_select_response" &&
        msg.requestId === selectRequestId &&
        msg.success === true,
    );

    ws.send(JSON.stringify({ type: "session_terminate", sessionId }));
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    ws.close();
  }
}

async function terminateSession(page: Page, sessionId: string): Promise<void> {
  await page.goto("/#/sessions");
  const row = page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`);
  if ((await row.count()) > 0) {
    await row.locator('[data-slot="session-row-menu-trigger"]').click();
    await page.locator('[data-slot="session-row-terminate-item"]').click();
    await page.locator('[data-slot="session-termination-confirm"]').click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
    return;
  }
  await terminateSessionByControl(sessionId);
}

test.describe("real JSON worker chaos", () => {
  test("keeps Claude JSON worker usable across relay restart and pending approval replay", async ({
    page,
  }) => {
    test.skip(
      !enabled,
      "integration chaos: 需要 `pnpm dev:chaos` 编排起 backend 并注入 JSON worker chaos provider (DEV_ANYWHERE_JSON_WORKER_CHAOS=1)",
    );

    const uniqueName = `dev-anywhere-json-worker-${Date.now()}`;
    const cwd = `${chaosRoot.replace(/\/$/, "")}/${uniqueName}`;
    mkdirSync(cwd, { recursive: true });

    const sessionId = await createJsonSession(page, cwd);

    try {
      await sendJsonMessage(page, "normal json smoke");
      await expect(page.getByText("JSON chaos reply: normal json smoke")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
        "data-state",
        "idle",
        {
          timeout: 15_000,
        },
      );
      await expectPendingApprovalCount(page, 0);

      await sendJsonMessage(page, "trigger approval please");
      await expectPendingApprovalCount(page, 1);
      await expect(
        page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`),
      ).toContainText("等待审批", { timeout: 15_000 });

      await page.reload();
      await expectPendingApprovalCount(page, 1, 30_000);
      await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
        "data-state",
        "waiting_approval",
        {
          timeout: 30_000,
        },
      );

      await restartRelayOnly();
      await expectPendingApprovalCount(page, 1, 30_000);

      const deny = page.locator('[data-slot="tool-approval-card"] [data-action="deny"]');
      await expect(deny).toBeEnabled({ timeout: 45_000 });
      await deny.click();
      await expectPendingApprovalCount(page, 0);
      await expect(page.getByText("JSON chaos approval: deny")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
        "data-state",
        "idle",
        {
          timeout: 15_000,
        },
      );
    } finally {
      await terminateSession(page, sessionId);
    }
  });

  test("does not leave stale approval UI after proxy serve restarts during pending approval", async ({
    page,
  }) => {
    test.skip(
      !enabled,
      "integration chaos: 需要 `pnpm dev:chaos` 编排起 backend 并注入 JSON worker chaos provider (DEV_ANYWHERE_JSON_WORKER_CHAOS=1)",
    );

    const uniqueName = `dev-anywhere-json-proxy-restart-${Date.now()}`;
    const cwd = `${chaosRoot.replace(/\/$/, "")}/${uniqueName}`;
    mkdirSync(cwd, { recursive: true });

    const sessionId = await createJsonSession(page, cwd);

    try {
      await sendJsonMessage(page, "trigger approval before proxy restart");
      await expectPendingApprovalCount(page, 1);
      await expect(page.locator('[data-slot="status-line"]')).toHaveAttribute(
        "data-state",
        "waiting_approval",
        { timeout: 15_000 },
      );

      await restartProxyServeWithFixture();
      await page.reload();
      await expectPendingApprovalCount(page, 0, 45_000);

      await page.goto("/#/sessions");
      const row = page.locator(`[data-slot="session-row"][data-session-id="${sessionId}"]:visible`);
      await expect
        .poll(
          async () => {
            if ((await row.count()) === 0) return true;
            const text = (await row.textContent()) ?? "";
            return !text.includes("等待审批");
          },
          { timeout: 45_000 },
        )
        .toBe(true);
    } finally {
      await terminateSession(page, sessionId);
    }
  });
});
