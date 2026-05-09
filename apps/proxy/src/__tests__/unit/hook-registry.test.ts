import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HookRegistry } from "#src/serve/hook-registry.js";

describe("HookRegistry", () => {
  it("registers session-scoped credentials and verifies token plus marker", () => {
    const registry = new HookRegistry();
    const credentials = registry.registerSession("s1", "claude", { now: 1000 });

    const binding = registry.verify({
      sessionId: credentials.sessionId,
      provider: "claude",
      marker: credentials.marker,
      token: credentials.token,
      now: 1000,
    });

    expect(binding?.sessionId).toBe("s1");
    expect(binding?.provider).toBe("claude");
    expect(binding?.tokenHash).not.toBe(credentials.token);
  });

  it("rejects wrong provider, token, marker, and expired bindings", () => {
    const registry = new HookRegistry();
    const credentials = registry.registerSession("s1", "claude", { now: 1000, ttlMs: 100 });

    expect(
      registry.verify({
        sessionId: "s1",
        provider: "codex",
        marker: credentials.marker,
        token: credentials.token,
      }),
    ).toBeNull();
    expect(
      registry.verify({
        sessionId: "s1",
        provider: "claude",
        marker: "wrong",
        token: credentials.token,
      }),
    ).toBeNull();
    expect(
      registry.verify({
        sessionId: "s1",
        provider: "claude",
        marker: credentials.marker,
        token: "wrong",
      }),
    ).toBeNull();
    expect(
      registry.verify({
        sessionId: "s1",
        provider: "claude",
        marker: credentials.marker,
        token: credentials.token,
        now: 1200,
      }),
    ).toBeNull();
  });

  it("restores session credentials across registry instances without persisting raw tokens", () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), "hook-registry-test-")), "hooks.json");
    const registry = new HookRegistry({ persistPath });
    const credentials = registry.registerSession("s1", "claude", { now: 1000 });

    const restored = new HookRegistry({ persistPath });

    expect(
      restored.verify({
        sessionId: credentials.sessionId,
        provider: credentials.provider,
        marker: credentials.marker,
        token: credentials.token,
        now: 1000,
      }),
    ).toMatchObject({
      sessionId: "s1",
      provider: "claude",
      marker: credentials.marker,
    });
    expect(readFileSync(persistPath, "utf8")).not.toContain(credentials.token);
  });
});
