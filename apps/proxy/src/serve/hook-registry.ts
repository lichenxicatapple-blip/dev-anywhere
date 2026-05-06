import { createHash, randomBytes } from "node:crypto";

export type HookProviderId = "claude" | "codex";

interface HookSessionBinding {
  sessionId: string;
  provider: HookProviderId;
  marker: string;
  tokenHash: string;
  createdAt: number;
  expiresAt?: number;
}

interface HookSessionCredentials {
  sessionId: string;
  provider: HookProviderId;
  marker: string;
  token: string;
}

interface VerifyOptions {
  sessionId: string;
  marker: string;
  token: string;
  provider?: HookProviderId;
  now?: number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export class HookRegistry {
  private readonly bindingsBySession = new Map<string, HookSessionBinding>();

  registerSession(
    sessionId: string,
    provider: HookProviderId,
    options: { ttlMs?: number; now?: number } = {},
  ): HookSessionCredentials {
    const now = options.now ?? Date.now();
    const token = randomSecret();
    const marker = randomSecret();
    this.bindingsBySession.set(sessionId, {
      sessionId,
      provider,
      marker,
      tokenHash: hashToken(token),
      createdAt: now,
      ...(options.ttlMs ? { expiresAt: now + options.ttlMs } : {}),
    });
    return { sessionId, provider, marker, token };
  }

  verify(options: VerifyOptions): HookSessionBinding | null {
    const binding = this.bindingsBySession.get(options.sessionId);
    if (!binding) return null;
    if (options.provider && binding.provider !== options.provider) return null;
    if (binding.marker !== options.marker) return null;
    if (binding.tokenHash !== hashToken(options.token)) return null;
    if (binding.expiresAt && (options.now ?? Date.now()) > binding.expiresAt) return null;
    return binding;
  }

  getSession(sessionId: string): HookSessionBinding | null {
    return this.bindingsBySession.get(sessionId) ?? null;
  }

  unregisterSession(sessionId: string): void {
    this.bindingsBySession.delete(sessionId);
  }
}
