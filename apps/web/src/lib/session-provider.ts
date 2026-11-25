import { providerValues, type HistorySession, type SessionInfo } from "@dev-anywhere/shared";

export type SessionProvider = SessionInfo["provider"];

export const PROVIDER_LABEL: Readonly<Record<SessionProvider, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi Code",
  cursor: "Cursor",
  antigravity: "agy",
};

const PROVIDER_ORDER = providerValues;

export function providerLabel(provider: SessionProvider): string {
  return PROVIDER_LABEL[provider];
}

export function compareProvider(a: SessionProvider, b: SessionProvider): number {
  return PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b);
}

export function historySessionProvider(session: HistorySession): SessionProvider {
  return session.provider;
}
