import { readStorageValue, STORAGE_KEYS, writeStorageValue } from "./storage-keys";

export const RELAY_CLIENT_TOKEN_KEY = STORAGE_KEYS.relayClientToken;

function readStoredRelayClientToken(): string | null {
  return (
    readStorageValue("local", RELAY_CLIENT_TOKEN_KEY) ??
    readStorageValue("session", RELAY_CLIENT_TOKEN_KEY)
  );
}

function persistRelayClientToken(token: string): void {
  writeStorageValue("local", RELAY_CLIENT_TOKEN_KEY, token);
  writeStorageValue("session", RELAY_CLIENT_TOKEN_KEY, token);
}

export function getRelayClientToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("relayToken");
  if (fromUrl) {
    persistRelayClientToken(fromUrl);
    return fromUrl;
  }
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
