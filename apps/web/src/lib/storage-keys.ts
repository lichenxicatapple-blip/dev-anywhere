type StorageKind = "local" | "session";

export const STORAGE_KEYS = {
  clientId: "dev_anywhere_clientId",
  proxyId: "dev_anywhere_proxyId",
  ptyFontSize: "dev_anywhere_ptyFontSize",
  chatContentFontSize: "dev_anywhere_chatContentFontSize",
  sidebarCollapsed: "dev_anywhere_sidebarCollapsed",
  relayClientToken: "dev_anywhere_relayClientToken",
  themePreference: "dev_anywhere_theme",
  latencyMonitorEnabled: "dev_anywhere_latencyMonitorEnabled",
  latencyMonitorPosition: "dev_anywhere_latencyMonitorPosition",
  sessionIdleNotificationsEnabled: "dev_anywhere_sessionIdleNotificationsEnabled",
  inputModePreference: "dev_anywhere_inputModePreference",
  adaptiveInputModality: "dev_anywhere_adaptiveInputModality",
  ipadFloatingKeyboardHintDismissed: "dev_anywhere_ipadFloatingKeyboardHintDismissed",
  ptyScrollTraceEnabled: "dev_anywhere_pty_scroll_trace",
  ptyAutoYesSessions: "dev_anywhere_pty_auto_yes_sessions",
} as const;

function getStorage(kind: StorageKind): Storage | null {
  try {
    const storage = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function" ||
      typeof storage.removeItem !== "function"
    ) {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

export function readStorageValue(kind: StorageKind, key: string): string | null {
  const storage = getStorage(kind);
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorageValue(kind: StorageKind, key: string, value: string): void {
  const storage = getStorage(kind);
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private browsing, tests, or embedded webviews.
  }
}

export function removeStorageValue(kind: StorageKind, key: string): void {
  const storage = getStorage(kind);
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore transient storage failures; app state remains in memory.
  }
}
