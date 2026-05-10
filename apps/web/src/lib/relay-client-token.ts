import {
  readStorageValue,
  removeStorageValue,
  STORAGE_KEYS,
  writeStorageValue,
} from "./storage-keys";

export const RELAY_CLIENT_TOKEN_KEY = STORAGE_KEYS.relayClientToken;

function readStoredRelayClientToken(): string | null {
  return (
    readStorageValue("local", RELAY_CLIENT_TOKEN_KEY) ??
    readStorageValue("session", RELAY_CLIENT_TOKEN_KEY)
  );
}

export function persistRelayClientToken(token: string): void {
  writeStorageValue("local", RELAY_CLIENT_TOKEN_KEY, token);
  writeStorageValue("session", RELAY_CLIENT_TOKEN_KEY, token);
}

export function clearRelayClientToken(): void {
  removeStorageValue("local", RELAY_CLIENT_TOKEN_KEY);
  removeStorageValue("session", RELAY_CLIENT_TOKEN_KEY);
}

// 候选 token 的来源优先级：URL query > localStorage > sessionStorage。
// 不再无脑把 URL 上的 token 写入 storage —— 那样错 token 会"感染"浏览器，
// 即使刷新去掉 ?relayToken=... 仍然报错。改成 preflight 通过后再 persist。
export function getRelayClientToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("relayToken");
  if (fromUrl) return fromUrl;
  return readStoredRelayClientToken();
}

export function toClientWsUrl(relayUrl: string): string {
  const withWsScheme = relayUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const trimmed = withWsScheme.replace(/\/$/, "");
  const token = getRelayClientToken();
  const base = /\/client$/.test(trimmed) ? trimmed : `${trimmed.replace(/\/proxy$/, "")}/client`;
  if (!token) return base;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}token=${encodeURIComponent(token)}`;
}
