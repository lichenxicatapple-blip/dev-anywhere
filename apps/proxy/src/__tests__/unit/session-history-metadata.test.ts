import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySessionHistoryMetadata,
  readSessionHistoryMetadata,
  upsertSessionHistoryMetadata,
} from "#src/serve/session-history-metadata.js";

type MetadataRecord = Parameters<typeof upsertSessionHistoryMetadata>[1];

function record(overrides: Partial<MetadataRecord> = {}): MetadataRecord {
  return {
    nativeSessionId: "native-session",
    devAnywhereSessionId: "runtime-session",
    provider: "claude",
    mode: "json",
    cwd: "/old/project",
    updatedAt: 1,
    ...overrides,
  };
}

function nativeSession() {
  return {
    id: "native-session",
    provider: "claude" as const,
    title: "Native title",
    projectDir: "/native/project",
    updatedAt: 100,
  };
}

describe("session history display metadata", () => {
  let testDir: string;
  let metadataPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "history-metadata-test-"));
    metadataPath = join(testDir, "history-metadata.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("applies an explicit user title and mode without overriding native facts", () => {
    const session = nativeSession();

    const result = applySessionHistoryMetadata(
      [session],
      [record({ title: "User title", nameLocked: true })],
    );

    expect(result).toEqual([{ ...session, title: "User title", preferredMode: "json" }]);
    expect(session).toEqual(nativeSession());
  });

  it("does not invent a native project directory from display metadata", () => {
    const session = { id: "native-session", provider: "claude" as const };

    const [result] = applySessionHistoryMetadata([session], [record()]);

    expect(result).toEqual({ ...session, preferredMode: "json" });
    expect(result).not.toHaveProperty("projectDir");
  });

  it.each([undefined, false])("ignores a title without nameLocked=true (%s)", (nameLocked) => {
    writeFileSync(metadataPath, JSON.stringify([record({ title: "Automatic title", nameLocked })]));

    const result = applySessionHistoryMetadata(
      [nativeSession()],
      readSessionHistoryMetadata(metadataPath),
    );

    expect(result).toEqual([{ ...nativeSession(), preferredMode: "json" }]);
  });

  it("round-trips the explicit-title marker and discards an invalid marker", () => {
    writeFileSync(
      metadataPath,
      JSON.stringify([
        record({ title: "  User title  ", nameLocked: true }),
        {
          ...record({ nativeSessionId: "invalid-marker", title: "Automatic" }),
          nameLocked: "true",
        },
      ]),
    );

    const records = readSessionHistoryMetadata(metadataPath);

    expect(records[0]).toMatchObject({ title: "User title", nameLocked: true });
    expect(records[1]).not.toHaveProperty("nameLocked");
  });

  it("associates by provider and native ID, not runtime ID or title", () => {
    const sessions = (["claude", "codex", "kimi"] as const).map((provider) => ({
      ...nativeSession(),
      provider,
    }));
    const records = sessions.map((session) =>
      record({
        provider: session.provider,
        devAnywhereSessionId: "unrelated-runtime",
        title: `User ${session.provider}`,
        nameLocked: true,
      }),
    );

    expect(applySessionHistoryMetadata(sessions, records)).toEqual(
      sessions.map((session) => ({
        ...session,
        title: `User ${session.provider}`,
        preferredMode: "json",
      })),
    );
    expect(applySessionHistoryMetadata([], records)).toEqual([]);
    expect(
      applySessionHistoryMetadata([{ ...nativeSession(), id: "another-native-id" }], records),
    ).toEqual([{ ...nativeSession(), id: "another-native-id" }]);
  });

  it("uses the latest preference record for the same native identity", () => {
    const records = [
      record({ title: "Old name", nameLocked: true, updatedAt: 1 }),
      record({ title: "New name", nameLocked: true, updatedAt: 2, mode: "pty" }),
    ];

    expect(applySessionHistoryMetadata([nativeSession()], records)).toEqual([
      { ...nativeSession(), title: "New name", preferredMode: "pty" },
    ]);
  });

  it("retains a user title when another runtime records its mode without a new user name", () => {
    upsertSessionHistoryMetadata(metadataPath, record({ title: "Saved name", nameLocked: true }));
    upsertSessionHistoryMetadata(
      metadataPath,
      record({ devAnywhereSessionId: "resumed-runtime", mode: "pty", updatedAt: 2 }),
    );

    const records = readSessionHistoryMetadata(metadataPath);
    expect(records).toEqual([
      record({
        devAnywhereSessionId: "resumed-runtime",
        mode: "pty",
        title: "Saved name",
        nameLocked: true,
        updatedAt: 2,
      }),
    ]);
  });

  it("updates only the matching provider/native ID when a user renames again", () => {
    upsertSessionHistoryMetadata(metadataPath, record({ title: "First name", nameLocked: true }));
    upsertSessionHistoryMetadata(
      metadataPath,
      record({ provider: "kimi", title: "Kimi name", nameLocked: true }),
    );
    upsertSessionHistoryMetadata(metadataPath, record({ title: "New name", nameLocked: true }));

    expect(readSessionHistoryMetadata(metadataPath)).toEqual([
      record({ title: "New name", nameLocked: true }),
      record({ provider: "kimi", title: "Kimi name", nameLocked: true }),
    ]);
  });

  it("never promotes an unmarked stored title into an explicit preference", () => {
    writeFileSync(metadataPath, JSON.stringify([record({ title: "Unattributed name" })]));
    upsertSessionHistoryMetadata(metadataPath, record({ mode: "pty", updatedAt: 2 }));

    expect(readSessionHistoryMetadata(metadataPath)).toEqual([
      record({ mode: "pty", updatedAt: 2 }),
    ]);
  });
});
