import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { serviceLogger } from "../common/logger.js";

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

interface HookRegistryOptions {
  persistPath?: string;
}

const PersistedHookSessionBindingSchema = z.object({
  sessionId: z.string(),
  provider: z.enum(["claude", "codex"]),
  marker: z.string(),
  tokenHash: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().optional(),
});

const PersistedHookRegistrySchema = z.object({
  version: z.literal(1),
  bindings: z.array(PersistedHookSessionBindingSchema),
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export class HookRegistry {
  private readonly bindingsBySession = new Map<string, HookSessionBinding>();
  private readonly persistPath?: string;

  constructor(options: HookRegistryOptions = {}) {
    this.persistPath = options.persistPath;
    this.load();
  }

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
    this.save();
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
    if (this.bindingsBySession.delete(sessionId)) {
      this.save();
    }
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const parsed = PersistedHookRegistrySchema.parse(
        JSON.parse(readFileSync(this.persistPath, "utf8")),
      );
      this.bindingsBySession.clear();
      for (const binding of parsed.bindings) {
        this.bindingsBySession.set(binding.sessionId, binding);
      }
    } catch (err) {
      serviceLogger.warn(
        { path: this.persistPath, error: String(err) },
        "Failed to load hook registry state",
      );
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmpPath = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(
        tmpPath,
        JSON.stringify(
          {
            version: 1,
            bindings: Array.from(this.bindingsBySession.values()),
          },
          null,
          2,
        ),
      );
      renameSync(tmpPath, this.persistPath);
    } catch (err) {
      serviceLogger.warn(
        { path: this.persistPath, error: String(err) },
        "Failed to persist hook registry state",
      );
    }
  }
}
