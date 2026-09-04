import type { HistorySession, SessionInfo } from "@dev-anywhere/shared";

export type SessionProvider = SessionInfo["provider"];

const PROVIDER_LABEL: Record<SessionProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi Code",
};

const PROVIDER_ORDER: SessionProvider[] = ["claude", "codex", "kimi"];

export function providerLabel(provider: SessionProvider): string {
  return PROVIDER_LABEL[provider];
}

export function compareProvider(a: SessionProvider, b: SessionProvider): number {
  return PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b);
}

export function historySessionProvider(session: HistorySession): SessionProvider {
  return session.provider;
}
