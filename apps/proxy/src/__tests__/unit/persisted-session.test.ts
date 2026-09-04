import { describe, expect, it } from "vitest";
import { PersistedSessionRecordSchema } from "#src/common/persisted-session.js";

describe("persisted session schema", () => {
  const identity = {
    id: "session-1",
    cwd: "/tmp/project",
    pid: 4242,
    createdAt: 1,
    updatedAt: 2,
  };

  it.each([
    {
      ...identity,
      kind: "agent",
      mode: "json",
      provider: "kimi",
    },
    {
      ...identity,
      kind: "agent",
      mode: "pty",
      provider: "codex",
      ptyOwner: "proxy-hosted",
    },
    {
      ...identity,
      kind: "terminal",
      mode: "pty",
      provider: "claude",
      ptyOwner: "local-terminal",
    },
  ])("accepts a complete current session identity", (record) => {
    expect(PersistedSessionRecordSchema.safeParse(record).success).toBe(true);
  });

  it.each(["id", "kind", "mode", "provider", "cwd", "pid", "createdAt", "updatedAt"])(
    "rejects a persisted JSON session without %s",
    (field) => {
      const record: Record<string, unknown> = {
        ...identity,
        kind: "agent",
        mode: "json",
        provider: "claude",
      };
      delete record[field];
      expect(PersistedSessionRecordSchema.safeParse(record).success).toBe(false);
    },
  );

  it("rejects a persisted PTY without an owner and unknown fields", () => {
    expect(
      PersistedSessionRecordSchema.safeParse({
        ...identity,
        kind: "agent",
        mode: "pty",
        provider: "claude",
      }).success,
    ).toBe(false);
    expect(
      PersistedSessionRecordSchema.safeParse({
        ...identity,
        kind: "agent",
        mode: "json",
        provider: "claude",
        state: "idle",
      }).success,
    ).toBe(false);
  });

  it.each([
    { kind: "terminal", mode: "json", provider: "claude" },
    {
      kind: "terminal",
      mode: "pty",
      provider: "kimi",
      ptyOwner: "local-terminal",
    },
    {
      kind: "terminal",
      mode: "pty",
      provider: "claude",
      ptyOwner: "proxy-hosted",
    },
  ])("rejects impossible pure-terminal identities", (record) => {
    expect(PersistedSessionRecordSchema.safeParse({ ...identity, ...record }).success).toBe(false);
  });
});
