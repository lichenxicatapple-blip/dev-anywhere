import type { ProviderId } from "../../providers/types.js";

/** Facts read from a provider's native store, before display preferences are applied. */
export interface NativeHistorySession {
  provider: ProviderId;
  id: string;
  projectDir?: string;
  title?: string;
  updatedAt: number;
  kind: "main" | "internal" | "unknown";
  hasConversation: boolean;
}

export interface SessionHistoryEntry {
  provider: ProviderId;
  id: string;
  projectDir: string;
  title: string;
  updatedAt: number;
  preferredMode?: "pty" | "json";
}

export const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function nativeSessionKey(session: Pick<NativeHistorySession, "provider" | "id">): string {
  return `${session.provider}:${session.id}`;
}
