import { test, expect } from "@playwright/test";
import { installFakeRelay, openCreateAgentSessionDialog, selectFakeProxy } from "../helpers";
import webPackage from "../../package.json" with { type: "json" };

const WEB_VERSION = webPackage.version;

test.describe("CreateSessionDialog — 字段校验", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await installFakeRelay(page);
    await selectFakeProxy(page);
  });

  test("新建会话弹窗内容不会被长 CLI 路径撑出边框", async ({ page }) => {
    await openCreateAgentSessionDialog(page);

    const dialog = page.locator('[data-slot="create-session-dialog"]');
    const form = page.locator('[data-slot="create-session-form"]');
    await expect(dialog).toBeVisible();
    await expect(page.getByText("/home/dev/.local/bin/claude")).toBeVisible();

    async function expectFormContained() {
      const overflowing = await form.evaluate((formNode) => {
        const dialogNode = formNode.closest('[data-slot="create-session-dialog"]');
        if (!dialogNode) return ["missing dialog"];
        const dialogRect = dialogNode.getBoundingClientRect();
        return Array.from(formNode.querySelectorAll("*"))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden") return false;
            if (rect.width === 0 || rect.height === 0) return false;
            return rect.left < dialogRect.left - 1 || rect.right > dialogRect.right + 1;
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return `${element.tagName.toLowerCase()} ${Math.round(rect.left)}-${Math.round(rect.right)}`;
          });
      });

      expect(overflowing).toEqual([]);
    }

    await expectFormContained();
    await page.getByRole("button", { name: "指定路径" }).click();
    await expectFormContained();
  });

  test("桌面底部终端按钮可以创建纯终端", async ({ page }) => {
    await expect(page.locator('[data-slot="create-session-split-trigger"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="create-session-type-menu"]')).toHaveCount(0);
    await page.locator('[data-slot="create-session-trigger"]:visible').click();
    await page.locator('[data-slot="create-terminal-session-item"]').click();

    await expect(page).toHaveURL(/\/chat\/created-terminal-\d+\?mode=pty/);
    await expect(page.locator('[data-slot="chat-session-title"]')).toContainText("~/workspace");
    await expect(page.locator('[data-slot="pty-terminal"]')).toBeVisible();
    await expect(page.locator('[data-slot="status-line"]')).toHaveCount(0);

    const row = page.locator('[data-slot="session-row"]').filter({ hasText: "~/workspace" });
    await expect(row.locator('[data-slot="session-mode-icon"][data-mode="pty"]')).toBeVisible();
    await expect(row).toContainText("运行中");
  });

  test("桌面侧边栏可以显式收起和展开", async ({ page }) => {
    await expect(page.locator('[data-slot="sidebar-session-list"]')).toBeVisible();

    await page.getByRole("button", { name: "收起侧边栏" }).click();
    await expect(page.locator('[data-slot="sidebar-session-list"]')).not.toBeVisible();
    await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();

    await page.getByRole("button", { name: "展开侧边栏" }).click();
    await expect(page.locator('[data-slot="sidebar-session-list"]')).toBeVisible();
  });

  test("设置菜单进入版本页后展示 Web 和 Relay 版本", async ({ page }) => {
    await page.route("**/health", async (route) => {
      await route.fulfill({
        json: { status: "ok", version: "9.8.7", uptime: 125 },
      });
    });

    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.locator('[data-slot="settings-dialog"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /版本/ })).toBeVisible();

    await page.getByRole("button", { name: /版本/ }).click();
    await expect(page.getByRole("heading", { name: "版本" })).toBeVisible();
    await expect(page.getByText("Web", { exact: true })).toBeVisible();
    await expect(page.getByText(WEB_VERSION)).toBeVisible();
    await expect(page.getByText("Relay 服务器", { exact: true })).toBeVisible();
    await expect(page.getByText("9.8.7")).toBeVisible();
    await expect(page.getByText("运行 2 分钟")).toBeVisible();
  });

  test("设置菜单可以查看并断开其他 Relay 客户端", async ({ page }) => {
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.locator('[data-slot="settings-dialog"]')).toBeVisible();

    const clientEntry = page.getByRole("button", { name: "客户端管理" });
    await expect(clientEntry).toContainText("已连接的浏览器页面和设备");
    await clientEntry.click();

    await expect(page.getByRole("heading", { name: "客户端管理" })).toBeVisible();
    await expect(page.getByText("2 个在线客户端")).toBeVisible();
    await expect(page.getByText("当前设备")).toBeVisible();
    await expect(page.locator('[data-client-id="browser-current"]')).toBeVisible();
    const otherClient = page.locator('[data-client-id="browser-ipad"]');
    await expect(otherClient).toBeVisible();
    await expect(otherClient.getByText("开发机", { exact: true })).toBeVisible();
    await expect(otherClient.getByText("Local Mac", { exact: true })).toBeVisible();
    await expect(page.getByText("开发机 Local Mac")).toHaveCount(0);

    await page.getByRole("button", { name: "断开" }).click();

    await expect(page.locator('[data-client-id="browser-ipad"]')).toHaveCount(0);
    await expect(page.getByText("1 个在线客户端")).toBeVisible();
    await expect(page.locator('[data-client-id="browser-current"]')).toBeVisible();
  });

  test("同路径的 Claude/Codex 历史目录折叠状态互不影响", async ({ page }) => {
    await page.evaluate(() => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "session_history_response",
        sessions: [
          {
            id: "hist-claude-same-dir",
            title: "Claude same dir",
            projectDir: "/home/dev/projects/dev-anywhere",
            updatedAt: Date.now() - 1_000,
            provider: "claude",
          },
          {
            id: "hist-codex-same-dir",
            title: "Codex same dir",
            projectDir: "/home/dev/projects/dev-anywhere",
            updatedAt: Date.now() - 2_000,
            provider: "codex",
          },
        ],
      });
    });

    await page.locator('[data-slot="history-section-header"]:visible').click();
    const codexHeader = page
      .locator('[data-slot="history-provider-header"]:visible')
      .filter({ hasText: "Codex" });
    await codexHeader
      .locator("xpath=following-sibling::ul[1]")
      .locator('[data-slot="history-group-header"]:visible')
      .filter({ hasText: "dev-anywhere" })
      .click();

    await expect(
      page.locator('[data-slot="history-row"][data-session-id="hist-codex-same-dir"]:visible'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="history-row"][data-session-id="hist-claude-same-dir"]:visible'),
    ).toHaveCount(0);
  });

  test("全部会话被截断的标题可通过 hover title 查看全名", async ({ page }) => {
    const longTitle =
      "A very long restored session title for checking the complete hover label in the history list";
    await page.evaluate((title) => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "session_history_response",
        sessions: [
          {
            id: "hist-long-title",
            title,
            projectDir: "/home/dev/projects/sample-app",
            updatedAt: Date.now() - 1_000,
            provider: "claude",
          },
        ],
      });
    }, longTitle);

    await page.locator('[data-slot="history-section-header"]:visible').click();
    await page
      .locator('[data-slot="history-group-header"]:visible')
      .filter({ hasText: "sample-app" })
      .click();

    const title = page
      .locator('[data-slot="history-row"][data-session-id="hist-long-title"]:visible span[title]')
      .first();
    await expect(title).toHaveAttribute("title", longTitle);
  });

  test("恢复会话弹窗不会被长标题撑出边框", async ({ page }) => {
    const longTitle =
      "不知道你能否看到，我们大概从 0.2.6 版本开始，就一直困于一个 UI 问题，" +
      "这是一个足够长的历史会话标题，用来确认恢复弹窗内部选项不会越过右边界";

    await page.evaluate((title) => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "session_history_response",
        sessions: [
          {
            id: "hist-restore-dialog-overflow",
            title,
            projectDir: "/home/dev/projects/sample-app",
            updatedAt: Date.now() - 1_000,
            provider: "claude",
            preferredMode: "pty",
          },
        ],
      });
    }, longTitle);

    await page.locator('[data-slot="history-section-header"]:visible').click();
    await page
      .locator('[data-slot="history-group-header"]:visible')
      .filter({ hasText: "sample-app" })
      .click();

    const row = page.locator(
      '[data-slot="history-row"][data-session-id="hist-restore-dialog-overflow"]:visible',
    );
    await expect(row).toBeVisible();
    await row.locator('button[aria-label^="恢复会话"]').click();

    const dialog = page.locator('[data-slot="history-restore-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("权限模式")).toBeVisible();

    const overflowing = await dialog.evaluate((dialogNode) => {
      const dialogRect = dialogNode.getBoundingClientRect();
      return Array.from(
        dialogNode.querySelectorAll<HTMLElement>(
          '[role="radio"], [data-slot="dialog-description"]',
        ),
      )
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (rect.width === 0 || rect.height === 0) return false;
          return rect.left < dialogRect.left - 1 || rect.right > dialogRect.right + 1;
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return `${element.getAttribute("aria-label") ?? element.getAttribute("data-slot") ?? element.tagName}:${Math.round(rect.left)}-${Math.round(rect.right)}`;
        });
    });

    expect(overflowing).toEqual([]);
  });

  test("桌面侧栏的活跃会话标题和全部会话在同一个滚动容器中", async ({ page }) => {
    const sameScrollContainer = await page.evaluate(() => {
      const activeHeader = Array.from(document.querySelectorAll("h3")).find((el) =>
        el.textContent?.includes("活跃会话"),
      );
      const historyHeader = document.querySelector('[data-slot="history-section-header"]');
      return (
        activeHeader?.closest(".dev-sidebar-scroll") ===
        historyHeader?.closest(".dev-sidebar-scroll")
      );
    });

    expect(sameScrollContainer).toBe(true);
  });
});
