export type BrowserNotificationPermissionResult = NotificationPermission | "unsupported";

export interface BrowserNotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

function notificationApi(): typeof Notification | null {
  return typeof globalThis.Notification === "function" ? globalThis.Notification : null;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionResult> {
  const api = notificationApi();
  if (!api) return "unsupported";
  if (api.permission === "granted" || api.permission === "denied") return api.permission;

  try {
    return await api.requestPermission();
  } catch {
    return "unsupported";
  }
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

function notificationOptions(payload: BrowserNotificationPayload): NotificationOptions {
  return {
    body: payload.body,
    tag: payload.tag,
    icon: new URL("/pwa-192x192.png", payload.url).toString(),
    badge: new URL("/pwa-64x64.png", payload.url).toString(),
    data: { url: payload.url },
  };
}

function openNotificationTarget(url: string): void {
  try {
    window.focus();
    window.location.assign(url);
  } catch {
    // The notification is still useful if a browser blocks focus or navigation.
  }
}

export async function showBrowserNotification(
  payload: BrowserNotificationPayload,
): Promise<boolean> {
  const api = notificationApi();
  if (!api || api.permission !== "granted") return false;
  const options = notificationOptions(payload);

  const registration = await serviceWorkerRegistration();
  if (registration) {
    try {
      await registration.showNotification(payload.title, options);
      return true;
    } catch {
      // Fall back to the page Notification API when the active worker rejects the request.
    }
  }

  try {
    const notification = new api(payload.title, options);
    notification.onclick = () => {
      notification.close();
      openNotificationTarget(payload.url);
    };
    return true;
  } catch {
    return false;
  }
}
