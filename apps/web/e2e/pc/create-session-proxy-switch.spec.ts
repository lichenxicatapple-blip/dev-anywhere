import { test, expect, type Page } from "@playwright/test";
import {
  BASE_URL,
  installFakeRelay,
  openCreateAgentSessionDialog,
  sentFakeRelayMessages,
} from "../helpers";

const homes = { windows: "C:/Users/windows", mac: "/Users/mac" } as const;
type Machine = keyof typeof homes;

async function selectMachine(page: Page, machine: Machine) {
  const trigger = page.locator('[data-slot="proxy-switcher-trigger"]');
  await trigger.click();
  await page.locator(`[data-slot="proxy-item"][data-proxy-id="${machine}"]:visible`).last().click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
}

test.describe("New session drafts belong to the selected machine", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await page.goto(`${BASE_URL}/#/`);
    await expect(page.locator('[data-slot="proxy-switcher-trigger"]')).toBeVisible();
    await page.evaluate(() => {
      const socket = window.__devAnywhereE2E!.socket!;
      const emit = socket.emitJson.bind(socket);
      let selected = "windows";
      socket.emitJson = (payload) => {
        if (payload.type === "proxy_select_response") selected = String(payload.proxyId);
        if (payload.type === "proxy_list_response") {
          payload = {
            ...payload,
            proxies: [
              {
                proxyId: "windows",
                name: "Test Windows",
                osName: "Windows",
                version: "0.10.7",
                online: true,
                sessions: [],
              },
              {
                proxyId: "mac",
                name: "Test Mac",
                osName: "macOS",
                version: "0.10.7",
                online: true,
                sessions: [],
              },
            ],
          };
        }
        if (payload.type === "proxy_info") {
          const homePath = selected === "windows" ? "C:/Users/windows" : "/Users/mac";
          payload = {
            ...payload,
            homePath,
            agentCli: {
              claude: { available: true, command: `${homePath}/bin/claude` },
              codex: { available: true, command: `${homePath}/bin/codex` },
            },
          };
        }
        emit(payload);
      };
      socket.emitJson({ type: "proxy_list_response", proxies: [] });
    });
  });

  for (const [first, next] of [
    ["windows", "mac"],
    ["mac", "windows"],
  ] as const) {
    test(`cancel on ${first}, then open on ${next}`, async ({ page }) => {
      await selectMachine(page, first);
      let dialog = await openCreateAgentSessionDialog(page);
      await expect(dialog.getByLabel("工作目录", { exact: true })).toHaveValue(homes[first]);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();

      await selectMachine(page, next);
      dialog = await openCreateAgentSessionDialog(page);
      await expect(dialog.getByLabel("工作目录", { exact: true })).toHaveValue(homes[next]);
      await expect(dialog.getByLabel("CLI 路径", { exact: true })).toHaveValue(
        `${homes[next]}/bin/claude`,
      );
      await expect(dialog.getByRole("button", { name: "创建", exact: true })).toBeEnabled();

      const messages = await sentFakeRelayMessages(page);
      expect(messages.filter((message) => message.type === "session_create")).toEqual([]);
    });
  }
});
