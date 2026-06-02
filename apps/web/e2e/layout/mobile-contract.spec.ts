import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  gotoWithFakeProxy,
  installFakeRelay,
  selectFakeProxy,
  sentFakeRelayMessages,
} from "../helpers";
import {
  MOBILE_VIEWPORTS,
  expectAllVisibleTouchTargets,
  expectNoHorizontalDocumentOverflow,
  expectTouchTarget,
  installVisualViewportMock,
} from "../mobile-helpers";

async function waitForAnimationFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () => {
          frames += 1;
          if (frames >= frameCount) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );
}

async function openMobileCreateTypeSheet(page: Page): Promise<Locator> {
  await page.locator('[data-slot="create-session-mobile-trigger"]:visible').click();
  const sheet = page.locator('[data-slot="create-session-type-sheet"]');
  await expect(sheet).toBeVisible();
  return sheet;
}

async function expectMobileInsetSurface(
  page: Page,
  surface: Locator,
  options: { minInset?: number; requireTopInset?: boolean } = {},
): Promise<void> {
  const minInset = options.minInset ?? 7;
  await expect(surface).toBeVisible();
  await expect
    .poll(async () => {
      return surface.evaluate(
        (node, { minInset: expectedInset, requireTopInset }) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.left >= expectedInset &&
            rect.right <= window.innerWidth - expectedInset &&
            rect.width <= window.innerWidth - expectedInset * 2 + 1 &&
            rect.top >= (requireTopInset ? expectedInset : -1) &&
            rect.bottom <= window.innerHeight + 1
          );
        },
        { minInset, requireTopInset: options.requireTopInset ?? false },
      );
    })
    .toBe(true);
  await expectNoHorizontalDocumentOverflow(page);
}

test.describe("mobile UX contract", () => {
  test.use({ viewport: MOBILE_VIEWPORTS.standard, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await installVisualViewportMock(page);
    await installFakeRelay(page);
  });

  test("proxy and session browsing are touch-safe without horizontal overflow", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator('[data-slot="app-shell-header"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="mobile-brand-hero"] [data-slot="brand-typewriter"]'),
    ).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="mobile-settings-trigger"]'));
    await expectNoHorizontalDocumentOverflow(page);
    await expectTouchTarget(page.locator('[data-slot="proxy-item"]').first());

    await selectFakeProxy(page);
    await expect(page).toHaveURL(/\/sessions/);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toBeVisible();
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).not.toContainText("左侧");
    await expectTouchTarget(page.locator('[data-slot="mobile-switch-proxy"]'));
    await expectNoHorizontalDocumentOverflow(page);
    await expectTouchTarget(page.locator('[data-slot="create-session-mobile-trigger"]'));
    await expectAllVisibleTouchTargets(
      page,
      '[data-slot="session-row"] button, [data-slot="history-row"]',
    );

    await page.locator('[data-slot="mobile-switch-proxy"]').click();
    await expect(page).toHaveURL(/\/#\/?$/);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="proxy-item"]').first()).toBeVisible();
    await expect(page.locator('[data-slot="mobile-switch-proxy"]')).toHaveCount(0);
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("mobile brand command fits the narrow phone header without shrinking the settings touch target", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 667 });
    await page.goto("/");

    const typewriter = page.locator(
      '[data-slot="mobile-brand-hero"] [data-slot="brand-typewriter"]',
    );
    await expect(typewriter).toBeVisible();

    const fit = await typewriter.evaluate((node) => {
      const probe = node.cloneNode(true) as HTMLElement;
      probe.textContent = "> /unlimited @anytime_";
      probe.style.position = "fixed";
      probe.style.left = "-10000px";
      probe.style.top = "0";
      probe.style.width = "max-content";
      probe.style.maxWidth = "none";
      probe.style.overflow = "visible";
      document.body.appendChild(probe);
      const result = {
        available: node.clientWidth,
        required: probe.getBoundingClientRect().width,
        whiteSpace: getComputedStyle(node).whiteSpace,
      };
      probe.remove();
      return result;
    });
    expect(fit.whiteSpace).toBe("nowrap");
    expect(fit.required).toBeLessThanOrEqual(fit.available + 1);

    const settings = page.locator('[data-slot="mobile-settings-trigger"]');
    const settingsVisual = page.locator('[data-slot="mobile-settings-trigger-visual"]');
    await expectTouchTarget(settings);
    const [typewriterBox, visualBox] = await Promise.all([
      typewriter.boundingBox(),
      settingsVisual.boundingBox(),
    ]);
    expect(typewriterBox).not.toBeNull();
    expect(visualBox).not.toBeNull();
    expect(Math.abs((visualBox?.height ?? 0) - (typewriterBox?.height ?? 0))).toBeLessThanOrEqual(
      7,
    );
    expect(
      Math.abs(
        (visualBox?.y ?? 0) +
          (visualBox?.height ?? 0) / 2 -
          ((typewriterBox?.y ?? 0) + (typewriterBox?.height ?? 0) / 2),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test("mobile shell settings opens the shared settings dialog", async ({ page }) => {
    await selectFakeProxy(page);
    const settings = page.locator('[data-slot="mobile-settings-trigger"]');

    await expect(settings).toBeVisible();
    await expectTouchTarget(settings);
    await settings.click();

    const dialog = page.locator('[data-slot="settings-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await expectMobileInsetSurface(page, dialog, { requireTopInset: true });
  });

  test("mobile Voice Pilot settings keep an inset dialog shell", async ({ page }) => {
    await selectFakeProxy(page);
    await page.locator('[data-slot="mobile-settings-trigger"]').click();
    await page.getByRole("button", { name: "Voice Pilot" }).click();

    const dialog = page.locator('[data-slot="settings-dialog"][data-view="voice"]');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("heading", { name: "设置 Voice Pilot" })).toBeVisible();
    await expectTouchTarget(dialog.locator('[data-slot="voice-settings-back"]'));
    await expectMobileInsetSurface(page, dialog, { requireTopInset: true });
  });

  test("mobile chat dialogs keep inset shells and touch-safe actions", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");
    await expect(page.getByLabel("输入聊天消息")).toBeVisible();

    await page.getByRole("button", { name: "会话操作" }).click();
    await page.locator('[data-slot="chat-menu-rename"]').click();
    const renameDialog = page.locator('[data-slot="session-rename-dialog"]');
    await expect(renameDialog).toBeVisible();
    await expectMobileInsetSurface(page, renameDialog, { requireTopInset: true });
    await expectTouchTarget(renameDialog.locator('[data-slot="dialog-close"]'));
    await expectTouchTarget(renameDialog.getByRole("button", { name: "取消" }));
    await expectTouchTarget(renameDialog.getByRole("button", { name: "保存" }));
    await renameDialog.locator('[data-slot="dialog-close"]').click();
    await expect(renameDialog).toBeHidden();

    await page.getByRole("button", { name: "会话操作" }).click();
    await page.locator('[data-slot="chat-menu-voice-pilot-item"]').click();
    const voiceDialog = page.locator('[data-slot="voice-pilot-wake-lock-dialog"]');
    await expect(voiceDialog).toBeVisible();
    await expectMobileInsetSurface(page, voiceDialog, { requireTopInset: true });
    await expectTouchTarget(voiceDialog.locator('[data-slot="dialog-close"]'));
    await expectTouchTarget(voiceDialog.getByRole("button", { name: "取消" }));
    await expectTouchTarget(voiceDialog.getByRole("button", { name: "开启 Voice Pilot" }));
  });

  test("mobile landscape settings dialog keeps close control inside the viewport", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS.landscape);
    await selectFakeProxy(page);

    const settings = page.locator('[data-slot="sidebar-settings-trigger"]');
    await expect(settings).toBeVisible();
    await expectTouchTarget(settings);
    await settings.click();
    const dialog = page.locator('[data-slot="settings-dialog"]');
    const close = dialog.locator('[data-slot="dialog-close"]');
    const body = dialog.locator('[data-slot="settings-dialog-body"]');

    await expect(dialog).toBeVisible();
    await expect(close).toBeVisible();
    await expectTouchTarget(close);
    await expectNoHorizontalDocumentOverflow(page);

    const metrics = await page.evaluate(() => {
      const dialogNode = document.querySelector<HTMLElement>('[data-slot="settings-dialog"]');
      const closeNode = dialogNode?.querySelector<HTMLElement>('[data-slot="dialog-close"]');
      const bodyNode = dialogNode?.querySelector<HTMLElement>('[data-slot="settings-dialog-body"]');
      const dialogRect = dialogNode?.getBoundingClientRect();
      const closeRect = closeNode?.getBoundingClientRect();
      const bodyRect = bodyNode?.getBoundingClientRect();
      return {
        innerHeight: window.innerHeight,
        dialog: dialogRect
          ? { top: dialogRect.top, bottom: dialogRect.bottom, height: dialogRect.height }
          : null,
        close: closeRect
          ? { top: closeRect.top, bottom: closeRect.bottom, height: closeRect.height }
          : null,
        body: bodyRect
          ? { top: bodyRect.top, bottom: bodyRect.bottom, height: bodyRect.height }
          : null,
      };
    });

    expect(metrics.dialog).not.toBeNull();
    expect(metrics.close).not.toBeNull();
    expect(metrics.body).not.toBeNull();
    expect(metrics.dialog?.top ?? -1).toBeGreaterThanOrEqual(-1);
    expect(metrics.dialog?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      metrics.innerHeight + 1,
    );
    expect(metrics.close?.top ?? -1).toBeGreaterThanOrEqual(-1);
    expect(metrics.close?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      metrics.innerHeight + 1,
    );
    expect(metrics.body?.height ?? 0).toBeGreaterThan(80);

    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(close).toBeVisible();
    await expectTouchTarget(close);
  });

  test("direct mobile sessions route without a proxy returns to proxy selection", async ({
    page,
  }) => {
    await page.goto("/#/sessions");

    await expect(page).toHaveURL(/\/#\/?$/);
    await expect(page.locator('[data-slot="proxy-item"]').first()).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="proxy-item"]').first());
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("direct mobile sessions route with a restorable proxy can return to proxy selection", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_proxyId", "proxy-1");
    });
    await page.goto("/#/sessions");

    await expect(page).toHaveURL(/\/sessions/);
    await expect(page.locator('[data-slot="mobile-brand-hero"]')).toHaveCount(1);
    const switchProxy = page.locator('[data-slot="mobile-switch-proxy"]');
    await expectTouchTarget(switchProxy);

    await switchProxy.click();
    await expect(page).toHaveURL(/\/#\/?$/);
    await expect(page.locator('[data-slot="proxy-item"]').first()).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("create session uses a mobile-safe surface and keeps file picker usable", async ({
    page,
  }) => {
    await selectFakeProxy(page);
    const sheet = await openMobileCreateTypeSheet(page);
    await expectMobileInsetSurface(page, sheet);
    await expectTouchTarget(sheet.locator('[data-slot="create-agent-session-sheet-item"]'));
    await expectTouchTarget(sheet.locator('[data-slot="create-terminal-session-sheet-item"]'));
    await expectTouchTarget(sheet.locator('[data-slot="sheet-close"]'));
    await sheet.locator('[data-slot="create-agent-session-sheet-item"]').click();

    const dialog = page.locator('[data-slot="create-session-dialog"]');
    await expect(dialog).toBeVisible();
    await expectMobileInsetSurface(page, dialog);
    await expectTouchTarget(dialog.locator('[data-slot="sheet-close"]'));
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (!active) return "";
          const label =
            active.getAttribute("aria-label") ?? active.getAttribute("aria-labelledby") ?? "";
          return `${active.tagName}:${label}`;
        }),
      )
      .not.toMatch(/^(INPUT|TEXTAREA):/);

    await expectTouchTarget(page.getByLabel("工作目录"));
    await expectTouchTarget(page.getByLabel("Agent CLI").getByRole("button", { name: /Claude/ }));
    await expectTouchTarget(page.getByLabel("交互方式").getByRole("button", { name: /终端模式/ }));
    const cliPathCard = page.locator('[data-slot="agent-cli-path-card"]');
    await expectTouchTarget(cliPathCard.getByRole("button", { name: "指定路径" }));
    const compactCliPathCardBox = await cliPathCard.boundingBox();
    expect(compactCliPathCardBox?.height ?? 0).toBeLessThanOrEqual(150);

    await cliPathCard.getByRole("button", { name: "指定路径" }).click();
    const cliPathInput = cliPathCard.locator('input[list^="agent-cli-path-"]');
    await expect(cliPathInput).toBeVisible();
    await expect
      .poll(() => cliPathInput.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)))
      .toBeGreaterThanOrEqual(16);
    await cliPathCard.getByRole("button", { name: "取消" }).click();

    await page.getByLabel("工作目录").focus();
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="select"]')).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="file-entry"]').first());
  });

  test("mobile create type sheet can start a pure terminal session", async ({ page }) => {
    await selectFakeProxy(page);
    const sheet = await openMobileCreateTypeSheet(page);

    await expect(sheet.getByRole("heading", { name: "新建" })).toBeVisible();
    await expectMobileInsetSurface(page, sheet);
    await expectTouchTarget(sheet.locator('[data-slot="create-agent-session-sheet-item"]'));
    await expectTouchTarget(sheet.locator('[data-slot="create-terminal-session-sheet-item"]'));
    await expectTouchTarget(sheet.locator('[data-slot="sheet-close"]'));
    await expect
      .poll(() =>
        sheet.evaluate((node) => {
          const color = getComputedStyle(node).backgroundColor.replace(/\s+/g, "");
          return color !== "rgb(255,255,255)" && color !== "rgba(0,0,0,0)";
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.locator('[data-slot="sheet-overlay"]').evaluate((node) => {
          const color = getComputedStyle(node).backgroundColor;
          const slashAlpha = color.match(/\/\s*([0-9.]+)\s*\)/);
          if (slashAlpha) return Number.parseFloat(slashAlpha[1]);
          const match = color.match(/rgba?\(([^)]+)\)/);
          if (!match) return -1;
          const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
          return parts.length >= 4 ? (parts[3] ?? 1) : 1;
        }),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.locator('[data-slot="sheet-overlay"]').evaluate((node) => {
          const color = getComputedStyle(node).backgroundColor;
          const slashAlpha = color.match(/\/\s*([0-9.]+)\s*\)/);
          if (slashAlpha) return Number.parseFloat(slashAlpha[1]);
          const match = color.match(/rgba?\(([^)]+)\)/);
          if (!match) return 1;
          const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
          return parts.length >= 4 ? (parts[3] ?? 1) : 1;
        }),
      )
      .toBeLessThanOrEqual(0.2);

    await sheet.locator('[data-slot="create-terminal-session-sheet-item"]').click();

    await expect(page).toHaveURL(/\/chat\/created-terminal-\d+\?mode=pty/);
    await expect(page.locator('[data-slot="chat-session-title"]')).toContainText("终端 · ~");
    await expect(page.locator('[data-slot="pty-terminal"]')).toBeVisible();
    await expect(page.locator('[data-slot="status-line"]')).toHaveCount(0);
    await expectNoHorizontalDocumentOverflow(page);

    const terminalCreate = (await sentFakeRelayMessages(page)).find(
      (msg) => msg.type === "session_create" && msg.kind === "terminal",
    );
    expect(terminalCreate).toMatchObject({ kind: "terminal", mode: "pty" });
  });

  test("restore session uses a mobile-safe sheet", async ({ page }) => {
    await selectFakeProxy(page);
    const longTitle =
      "This is an automated dev-anywhere restore-session title long enough to stress the mobile sheet bounds";
    await page.evaluate((title) => {
      window.__devAnywhereE2E?.socket?.emitJson({
        type: "session_history_response",
        sessions: [
          {
            id: "hist-mobile-restore-sheet",
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
      '[data-slot="history-row"][data-session-id="hist-mobile-restore-sheet"]:visible',
    );
    await expect(row).toBeVisible();
    await row.locator('button[aria-label^="恢复会话"]').click();

    const sheet = page.locator('[data-slot="history-restore-dialog"]');
    const footer = page.locator('[data-slot="history-restore-footer"]');
    await expect(sheet).toBeVisible();
    await expect(footer).toBeVisible();
    await expectMobileInsetSurface(page, sheet);
    await expectTouchTarget(sheet.locator('[data-slot="sheet-close"]'));
    await expectTouchTarget(footer.getByRole("button", { name: "恢复终端" }));
    await expectTouchTarget(footer.getByRole("button", { name: "取消" }));

    await expect
      .poll(async () =>
        sheet.evaluate((node) => {
          const sheetRect = node.getBoundingClientRect();
          const footerRect = node
            .querySelector<HTMLElement>('[data-slot="history-restore-footer"]')
            ?.getBoundingClientRect();
          const overflow = Array.from(
            node.querySelectorAll<HTMLElement>('[role="radio"], [data-slot="sheet-description"]'),
          ).filter((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            return rect.left < sheetRect.left - 1 || rect.right > sheetRect.right + 1;
          });
          return (
            sheetRect.top >= -1 &&
            sheetRect.bottom <= window.innerHeight + 1 &&
            (footerRect?.bottom ?? 0) <= window.innerHeight + 1 &&
            overflow.length === 0
          );
        }),
      )
      .toBe(true);
  });

  test("app shell follows expanded visual viewport when browser chrome moves", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const body = getComputedStyle(document.body);
          const root = getComputedStyle(document.querySelector("#root") as HTMLElement);
          return {
            bodyOverflow: body.overflow,
            rootOverflow: root.overflow,
          };
        }),
      )
      .toEqual({ bodyOverflow: "hidden", rootOverflow: "hidden" });
    const baseline = await page.locator('[data-slot="app-shell"]').evaluate((node) => {
      return node.getBoundingClientRect().height;
    });

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: window.innerHeight + 72,
        offsetTop: 0,
      }),
    );

    await expect
      .poll(() =>
        page.locator('[data-slot="app-shell"]').evaluate((node) => {
          return node.getBoundingClientRect().height;
        }),
      )
      .toBeGreaterThanOrEqual(baseline + 70);
  });

  test("standalone tablet shell includes the layout viewport safe-area canvas", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", {
        configurable: true,
        value: true,
      });
    });
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");

    const shell = page.locator('[data-slot="app-shell"]');
    await expect(shell).toHaveAttribute("data-standalone-display", "true");
    await expect
      .poll(() =>
        shell.evaluate((node) => {
          return getComputedStyle(node).getPropertyValue("--dev-app-shell-height").trim();
        }),
      )
      .toContain("100vh");
  });

  test("json input survives visual viewport keyboard changes", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
    const input = page.getByLabel("输入聊天消息");
    await input.click();

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );

    const root = page.locator("[data-keyboard-offset]").first();
    await expect(root).toHaveAttribute("data-keyboard-offset", /[1-9]\d*/);
    await expect(root).toHaveAttribute("data-keyboard-layout-inset", /[1-9]\d*/);
    // BackToBottom 在 visible=false 时用 inert 隔离交互 + AT (替代 aria-hidden +
    // tabIndex, 后者不阻止 retain focus 会触发浏览器警告)。inert 是 IDL boolean
    // property, attribute 序列化是 ""; 用 JS property 断言更稳。
    await expect(page.locator('[data-slot="back-to-bottom"]')).toHaveJSProperty("inert", true);
    await expect
      .poll(() => listIsPinnedToBottom(page.locator('[data-slot="message-list"]')))
      .toBe(true);
    await expectNoHorizontalDocumentOverflow(page);

    await input.fill("/");
    await expect(page.locator('[data-slot="slash-command-picker"]')).toBeVisible();
    await expectTouchTarget(
      page.locator('[data-slot="slash-command-picker"] [data-slot="command-item"]').first(),
    );

    await input.fill("@");
    await expect(page.locator('[data-slot="file-path-picker"][data-mode="insert"]')).toBeVisible();
    await expectTouchTarget(page.locator('[data-slot="file-entry"]').first());
  });

  test("json input on touch tablet does not add a visible bottom layout gutter", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        value: 5,
      });
    });
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
    const input = page.getByLabel("输入聊天消息");
    await input.click();

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.55),
        offsetTop: 0,
      }),
    );

    const root = page.locator("[data-keyboard-offset]").first();
    await expect(root).toHaveAttribute("data-keyboard-offset", /[1-9]\d*/);
    await expect(root).toHaveAttribute("data-keyboard-layout-inset", "0");
    await expect
      .poll(() =>
        root.evaluate((node) => {
          return getComputedStyle(node).paddingBottom;
        }),
      )
      .toBe("0px");
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("browser chrome viewport changes do not create fake keyboard padding", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");
    const input = page.getByLabel("输入聊天消息");
    await input.click();

    await page.evaluate(() =>
      window.__devAnywhereSetVisualViewport?.({
        height: Math.floor(window.innerHeight * 0.86),
        offsetTop: 0,
      }),
    );

    const root = page.locator("[data-keyboard-offset]").first();
    await expect(root).toHaveAttribute("data-keyboard-offset", "0");
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("json history pages load on upward scroll in mobile chat", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json");

    const list = page.locator('[data-slot="message-list"]');
    await expect(list).toBeVisible();
    await expect(page.getByText("移动端历史问题：请检查 JSON 渲染。")).toBeVisible();
    await expect(page.getByText("移动端历史回复：历史消息已经加载。")).toBeVisible();
    await expect(page.getByText("更早历史 01")).toHaveCount(0);
    await expectNoHorizontalDocumentOverflow(page);

    await list.evaluate((node) => {
      for (let i = 0; i < 3; i += 1) {
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    });
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page)).filter(
            (msg) => msg.type === "session_messages_request" && msg.sessionId === "hist-sess",
          ).length,
      )
      .toBeGreaterThanOrEqual(2);

    await list.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.getByText("更早历史 01")).toBeVisible();
    await expect(page.locator('[data-slot="history-scrollback-status"]')).toContainText(
      "已到最早记录",
    );
    await expectNoHorizontalDocumentOverflow(page);

    const historyRequests = (await sentFakeRelayMessages(page)).filter(
      (msg) => msg.type === "session_messages_request" && msg.sessionId === "hist-sess",
    );
    expect(historyRequests[0]).toMatchObject({ limit: 50 });
    expect(historyRequests.filter((msg) => msg.before === "hist-before-13")).toHaveLength(1);
    expect(historyRequests[1]).toMatchObject({ before: "hist-before-13", limit: 50 });
  });

  test("json scroll trace records upward history scroll diagnostics", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_json_scroll_trace", "1");
    });
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json");

    const list = page.locator('[data-slot="message-list"]');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-slot="json-scroll-trace-copy"]')).toBeVisible();

    await list.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const trace =
            (
              window as Window & {
                __devAnywhereJsonScrollTrace?: Array<{ event?: string }>;
              }
            ).__devAnywhereJsonScrollTrace ?? [];
          return trace.some(
            (entry) => entry.event === "scroll" || entry.event === "scroll:top-threshold",
          );
        }),
      )
      .toBeTruthy();
  });

  test("json upward scroll keeps virtual height stable for short mobile messages", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_json_scroll_trace", "1");
    });
    await gotoWithFakeProxy(page, "/#/chat/fo-sess?mode=json");

    await page.evaluate(() => {
      const hooks = window.__ccTest;
      if (!hooks) throw new Error("window.__ccTest 未安装");
      const sid = "fo-sess";
      for (let i = 0; i < 70; i += 1) {
        hooks.chat.addUserMessage(sid, {
          id: `mobile-jitter-u-${i}`,
          role: "user",
          text: `短消息 ${i}`,
          isPartial: false,
          timestamp: Date.now() + i,
          toolCalls: [],
        });
        hooks.chat.appendAssistantText(sid, `收到 ${i}`);
        hooks.chat.markTurnComplete(sid);
      }
    });

    const list = page.locator('[data-slot="message-list"]');
    await expect(list).toBeVisible();
    await expect
      .poll(() =>
        list.evaluate((node) => {
          const el = node as HTMLElement;
          return el.scrollHeight > el.clientHeight;
        }),
      )
      .toBe(true);
    await list.evaluate((node) => {
      const el = node as HTMLElement;
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect
      .poll(() =>
        list.evaluate((node) => {
          const el = node as HTMLElement;
          return el.scrollHeight - (el.scrollTop + el.clientHeight);
        }),
      )
      .toBeLessThanOrEqual(8);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    const scrollTraceCountBeforeWheel = await page.evaluate(() => {
      const trace =
        (
          window as Window & {
            __devAnywhereJsonScrollTrace?: Array<{ event?: string }>;
          }
        ).__devAnywhereJsonScrollTrace ?? [];
      return trace.filter((entry) => entry.event === "scroll").length;
    });
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 40);
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.wheel(0, -260);
      await waitForAnimationFrames(page, 1);
    }
    await expect
      .poll(() =>
        page.evaluate(() => {
          const trace =
            (
              window as Window & {
                __devAnywhereJsonScrollTrace?: Array<{ event?: string }>;
              }
            ).__devAnywhereJsonScrollTrace ?? [];
          return trace.filter((entry) => entry.event === "scroll").length;
        }),
      )
      .toBeGreaterThan(scrollTraceCountBeforeWheel);

    const totalSizeRange = await page.evaluate(() => {
      const trace =
        (
          window as Window & {
            __devAnywhereJsonScrollTrace?: Array<{ event?: string; totalSize?: number }>;
          }
        ).__devAnywhereJsonScrollTrace ?? [];
      const scrollTotals = trace
        .filter((entry) => entry.event === "scroll" && typeof entry.totalSize === "number")
        .map((entry) => entry.totalSize as number);
      return Math.max(...scrollTotals) - Math.min(...scrollTotals);
    });

    expect(totalSizeRange).toBeLessThan(180);
  });

  test("json send renders one user bubble and the assistant reply on mobile", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/test-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    await input.fill("移动端发送冒烟");
    const send = page.locator('[data-slot="send-button"][data-variant="send"]');
    await expectTouchTarget(send);
    await send.click();

    const userBubbles = page.locator('[data-slot="message-bubble"][data-role="user"]', {
      hasText: "移动端发送冒烟",
    });
    await expect(userBubbles).toHaveCount(1);
    await expect(
      page.locator('[data-slot="message-bubble"][data-role="assistant"]', { hasText: "收到。" }),
    ).toHaveCount(1);
    const inputCard = page.locator('[data-slot="input-card"]');
    const assistantRow = page
      .locator('[data-slot="message-bubble"][data-role="assistant"]', { hasText: "收到。" })
      .locator('[data-slot="message-row"]');
    const userRow = userBubbles.locator('[data-slot="message-row"]');
    const [inputBox, assistantRowBox, userRowBox] = await Promise.all([
      inputCard.boundingBox(),
      assistantRow.boundingBox(),
      userRow.boundingBox(),
    ]);
    expect(inputBox).not.toBeNull();
    expect(assistantRowBox).not.toBeNull();
    expect(userRowBox).not.toBeNull();
    expect(Math.abs((assistantRowBox?.x ?? 0) - (inputBox?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        (userRowBox?.x ?? 0) +
          (userRowBox?.width ?? 0) -
          ((inputBox?.x ?? 0) + (inputBox?.width ?? 0)),
      ),
    ).toBeLessThanOrEqual(1);
    await expectNoHorizontalDocumentOverflow(page);

    const sent = await sentFakeRelayMessages(page);
    const userInput = sent.find((msg) => msg.type === "user_input");
    expect(userInput).toBeTruthy();
    expect((userInput?.payload as { messageId?: string } | undefined)?.messageId).toMatch(
      /^test-sess-user-/,
    );
  });

  test("json chat font size controls both bubbles and the input field", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/hist-sess?mode=json");

    const input = page.getByLabel("输入聊天消息");
    const bubbleContent = page.locator('[data-slot="message-bubble"] [style*="font-size"]').first();
    await expect(bubbleContent).toBeVisible();

    const readFontSize = (locator: typeof input) =>
      locator.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    const inputBefore = await readFontSize(input);
    const bubbleBefore = await readFontSize(bubbleContent);
    expect(inputBefore).toBeGreaterThanOrEqual(16);
    expect(bubbleBefore).toBe(inputBefore);

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await expect(page.getByText("字号")).toBeVisible();
    await expect(page.getByText("聊天字号")).toHaveCount(0);
    await expect(page.getByText("终端字号")).toHaveCount(0);
    const largerFont = page.locator('[data-slot="chat-menu-font-larger"]');
    await expect(largerFont).toBeVisible();
    await largerFont.click();

    await expect.poll(() => readFontSize(bubbleContent)).toBe(bubbleBefore + 1);
    await expect.poll(() => readFontSize(input)).toBe(inputBefore + 1);
  });

  test("approval card is touch-safe and can deny from mobile", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/json-sess?mode=json");

    const card = page.locator('[data-slot="tool-approval-card"][data-status="pending"]');
    await expect(card).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
    await expectTouchTarget(card.getByRole("button", { name: "展开详情" }));
    await expectTouchTarget(card.getByRole("button", { name: "始终允许", exact: true }));
    await expectTouchTarget(card.getByRole("button", { name: "拒绝", exact: true }));
    await expectTouchTarget(card.getByRole("button", { name: "允许", exact: true }));

    await card.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await sentFakeRelayMessages(page)).filter((msg) => msg.type === "tool_deny").length,
      )
      .toBeGreaterThanOrEqual(1);
  });

  test("pty terminal is visible and orientation-safe", async ({ page }) => {
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);

    const terminalBox = await page.locator('[data-slot="pty-terminal"]').boundingBox();
    expect(terminalBox?.height ?? 0).toBeGreaterThan(180);
    const hostBox = await page.locator('[data-slot="pty-host"]').boundingBox();
    expect(hostBox?.width ?? 0).toBeGreaterThan(300);

    await page.locator('[data-slot="chat-overflow-trigger"]').click();
    await expect(page.locator('[data-slot="chat-menu-font-control"]')).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
    await page.keyboard.press("Escape");

    await page.setViewportSize(MOBILE_VIEWPORTS.landscape);
    await expect(page.locator('[data-slot="chat-pty-view"]')).toBeVisible();
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();
    await expectNoHorizontalDocumentOverflow(page);
  });

  test("pty terminal keeps its terminal theme when the app is in light mode", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("dev_anywhere_theme", "light");
    });
    await gotoWithFakeProxy(page, "/#/chat/claude-pty?mode=pty");
    await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(() => {
          return window.__ccTestPtyTerminals?.get("claude-pty")?.options.theme?.background;
        }),
      )
      .toBe("#1E1E1E");
    await expect
      .poll(() =>
        page.locator('[data-slot="pty-terminal"]').evaluate((node) => {
          return getComputedStyle(node).backgroundColor;
        }),
      )
      .toBe("rgb(30, 30, 30)");
    await expect
      .poll(() =>
        page.locator('[data-slot="pty-host"] .xterm-viewport').evaluate((node) => {
          return getComputedStyle(node).backgroundColor;
        }),
      )
      .toBe("rgb(30, 30, 30)");
  });
});

async function listIsPinnedToBottom(list: Locator): Promise<boolean> {
  return list.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 8);
}
