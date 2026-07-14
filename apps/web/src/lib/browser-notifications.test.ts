import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestBrowserNotificationPermission,
  showBrowserNotification,
} from "./browser-notifications";

interface FakeNotificationInstance {
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

function installNotificationApi(permission: NotificationPermission) {
  const instances: FakeNotificationInstance[] = [];
  class FakeNotification implements FakeNotificationInstance {
    static permission = permission;
    static requestPermission = vi.fn().mockResolvedValue("granted");
    title: string;
    options?: NotificationOptions;
    onclick: (() => void) | null = null;
    close = vi.fn();

    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      instances.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  return { FakeNotification, instances };
}

describe("browser notifications", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window.navigator, "serviceWorker");
  });

  it("reports unsupported when the Notification API is unavailable", async () => {
    vi.stubGlobal("Notification", undefined);

    await expect(requestBrowserNotificationPermission()).resolves.toBe("unsupported");
  });

  it("requests permission only when it has not been decided", async () => {
    const { FakeNotification } = installNotificationApi("default");

    await expect(requestBrowserNotificationPermission()).resolves.toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("uses the page Notification API when no service worker registration is active", async () => {
    const { instances } = installNotificationApi("granted");
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue(undefined) },
    });

    await expect(
      showBrowserNotification({
        title: "会话已空闲",
        body: "sample-app · Work Mac",
        tag: "session-1:101",
        url: "http://localhost:3000/#/chat/session-1?mode=pty",
      }),
    ).resolves.toBe(true);

    expect(instances).toHaveLength(1);
    expect(instances[0]?.title).toBe("会话已空闲");
    expect(instances[0]?.options).toMatchObject({
      body: "sample-app · Work Mac",
      tag: "session-1:101",
      data: { url: "http://localhost:3000/#/chat/session-1?mode=pty" },
    });
    expect(instances[0]?.onclick).toBeTypeOf("function");
  });

  it("prefers the active service worker for installed web apps", async () => {
    installNotificationApi("granted");
    const showNotification = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({ showNotification }),
      },
    });

    await expect(
      showBrowserNotification({
        title: "会话已空闲",
        body: "sample-app",
        tag: "session-1:101",
        url: "http://localhost:3000/#/chat/session-1?mode=json",
      }),
    ).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledWith(
      "会话已空闲",
      expect.objectContaining({
        body: "sample-app",
        tag: "session-1:101",
        data: { url: "http://localhost:3000/#/chat/session-1?mode=json" },
      }),
    );
  });
});
