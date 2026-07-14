import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, installFakeRelay, selectFakeProxy } from "../helpers";

interface NotificationRecord {
  title: string;
  options?: NotificationOptions;
}

declare global {
  interface Window {
    __devAnywhereNotificationE2E?: {
      records: NotificationRecord[];
      permissionRequests: number;
      click(index: number): void;
    };
  }
}

async function installNotificationProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const records: NotificationRecord[] = [];
    const instances: Array<{
      onclick: ((event: Event) => void) | null;
    }> = [];
    const probe = {
      records,
      permissionRequests: 0,
      click(index: number) {
        instances[index]?.onclick?.(new Event("click"));
      },
    };

    class FakeNotification {
      static permission: NotificationPermission = "default";
      static async requestPermission(): Promise<NotificationPermission> {
        probe.permissionRequests += 1;
        FakeNotification.permission = "granted";
        return "granted";
      }

      onclick: ((event: Event) => void) | null = null;

      constructor(title: string, options?: NotificationOptions) {
        records.push({ title, options });
        instances.push(this);
      }

      close(): void {}
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: FakeNotification,
    });
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => undefined },
    });
    Object.defineProperty(window, "__devAnywhereNotificationE2E", {
      configurable: true,
      value: probe,
    });
  });
}

async function emitSessionStatus(
  page: Page,
  state: "idle" | "working" | "compacting" | "waiting_approval" | "error",
  lastActive: number,
): Promise<void> {
  await page.evaluate(
    ({ state, lastActive }) => {
      window.__devAnywhereE2E?.socket?.emitJson({
        seq: lastActive,
        sessionId: "json-sess",
        timestamp: lastActive,
        source: "proxy",
        version: "1",
        type: "session_status",
        payload: {
          sessionId: "json-sess",
          state,
          lastActive,
        },
      });
    },
    { state, lastActive },
  );
}

test.describe("会话空闲浏览器通知", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("默认关闭，开启后仅在忙碌转空闲时通知并可返回会话", async ({ page }) => {
    await installNotificationProbe(page);
    await installFakeRelay(page);
    await selectFakeProxy(page);

    const sessionRow = page.locator(
      '[data-slot="session-row"][data-session-id="json-sess"]:visible',
    );
    const notificationCount = () =>
      page.evaluate(() => window.__devAnywhereNotificationE2E?.records.length ?? 0);

    expect(
      await page.evaluate(() =>
        localStorage.getItem("dev_anywhere_sessionIdleNotificationsEnabled"),
      ),
    ).toBeNull();

    await emitSessionStatus(page, "working", 1_000);
    await expect(sessionRow.getByRole("status")).toHaveAttribute("aria-label", "会话状态：工作中");
    await emitSessionStatus(page, "idle", 1_001);
    await expect(sessionRow.getByRole("status")).toHaveAttribute("aria-label", "会话状态：空闲");
    await expect.poll(notificationCount).toBe(0);

    await page.getByRole("button", { name: "设置" }).click();
    const toggle = page.getByRole("switch", { name: "会话空闲通知" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() => page.evaluate(() => window.__devAnywhereNotificationE2E?.permissionRequests ?? 0))
      .toBe(1);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("dev_anywhere_sessionIdleNotificationsEnabled"),
      ),
    ).toBe("1");
    await page.keyboard.press("Escape");

    await emitSessionStatus(page, "working", 2_000);
    await expect(sessionRow.getByRole("status")).toHaveAttribute("aria-label", "会话状态：工作中");
    await emitSessionStatus(page, "idle", 2_001);
    await expect.poll(notificationCount).toBe(1);

    const record = await page.evaluate(() => window.__devAnywhereNotificationE2E?.records[0]);
    const expectedUrl = await page.evaluate(
      () => `${window.location.origin}/#/chat/json-sess?mode=json`,
    );
    expect(record).toMatchObject({
      title: "会话已空闲",
      options: {
        body: "json-sess · Local Mac",
        tag: "dev-anywhere-session-idle:proxy-1:json-sess:2001",
        data: {
          url: expectedUrl,
        },
      },
    });

    await emitSessionStatus(page, "idle", 2_001);
    await expect.poll(notificationCount).toBe(1);

    await page.evaluate(() => window.__devAnywhereNotificationE2E?.click(0));
    await expect(page).toHaveURL(/\/#\/chat\/json-sess\?mode=json$/);
  });

  test("通过 Chromium 原生 Service Worker 发送可回读的系统通知", async ({ context, page }) => {
    const origin = new URL(BASE_URL).origin;
    await context.grantPermissions(["notifications"], { origin });
    await installFakeRelay(page);
    await selectFakeProxy(page);

    const nativeState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/notification-sw.js", {
        scope: "/",
      });
      await navigator.serviceWorker.ready;
      const existing = await registration.getNotifications();
      existing.forEach((notification) => notification.close());
      return {
        permission: Notification.permission,
        source: Function.prototype.toString.call(Notification),
      };
    });
    test.skip(
      nativeState.permission !== "granted",
      "Chromium headless 固定拒绝系统通知权限；使用 --headed 运行原生通知验证",
    );
    expect(nativeState.permission).toBe("granted");
    expect(nativeState.source).toContain("[native code]");

    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("switch", { name: "会话空闲通知" }).click();
    await page.keyboard.press("Escape");

    await emitSessionStatus(page, "working", 3_000);
    await emitSessionStatus(page, "idle", 3_001);

    const readNotifications = () =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) return [];
        return (await registration.getNotifications()).map((notification) => ({
          title: notification.title,
          body: notification.body,
          tag: notification.tag,
          data: notification.data,
        }));
      });
    await expect.poll(async () => (await readNotifications()).length).toBe(1);
    expect(await readNotifications()).toEqual([
      {
        title: "会话已空闲",
        body: "json-sess · Local Mac",
        tag: "dev-anywhere-session-idle:proxy-1:json-sess:3001",
        data: {
          url: `${origin}/#/chat/json-sess?mode=json`,
        },
      },
    ]);

    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return;
      (await registration.getNotifications()).forEach((notification) => notification.close());
      await registration.unregister();
    });
  });
});
