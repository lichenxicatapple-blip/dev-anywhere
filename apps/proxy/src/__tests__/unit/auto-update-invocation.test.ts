import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectAutoUpdateInvocation } from "#src/common/auto-update-invocation.js";

const NOW = 1_800_000_000_000;
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dev-anywhere-update-invocation-"));
  roots.push(root);
  return root;
}

function writeLock(root: string, record: unknown): string {
  const lockPath = join(root, "auto-update.lock");
  writeFileSync(lockPath, JSON.stringify(record), { mode: 0o600 });
  return lockPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("direct auto-update invocation detection", () => {
  it("matches the live lock owner to the CLI parent", () => {
    const lockPath = writeLock(makeRoot(), { pid: 4321, createdAt: NOW - 1_000 });

    expect(isDirectAutoUpdateInvocation({ lockPath, parentPid: 4321, now: NOW })).toBe(true);
  });

  it("does not mistake a manual command for the updater", () => {
    const lockPath = writeLock(makeRoot(), { pid: 4321, createdAt: NOW - 1_000 });

    expect(isDirectAutoUpdateInvocation({ lockPath, parentPid: 9876, now: NOW })).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-json"],
    ["invalid pid", JSON.stringify({ pid: -1, createdAt: NOW })],
    ["invalid timestamp", JSON.stringify({ pid: 4321, createdAt: "now" })],
  ])("fails closed for a %s lock", (_label, contents) => {
    const root = makeRoot();
    const lockPath = join(root, "auto-update.lock");
    if (contents !== undefined) writeFileSync(lockPath, contents, { mode: 0o600 });

    expect(isDirectAutoUpdateInvocation({ lockPath, parentPid: 4321, now: NOW })).toBe(false);
  });

  it("rejects a stale lock even when its PID matches", () => {
    const lockPath = writeLock(makeRoot(), {
      pid: 4321,
      createdAt: NOW - 30 * 60_000 - 1,
    });

    expect(isDirectAutoUpdateInvocation({ lockPath, parentPid: 4321, now: NOW })).toBe(false);
  });

  it.each([
    ["future", NOW + 1],
    ["fractional", NOW - 0.5],
  ])("rejects a %s lock timestamp", (_label, createdAt) => {
    const lockPath = writeLock(makeRoot(), { pid: 4321, createdAt });

    expect(isDirectAutoUpdateInvocation({ lockPath, parentPid: 4321, now: NOW })).toBe(false);
  });

  it("rejects symlinks and oversized lock records", () => {
    const root = makeRoot();
    const target = writeLock(root, { pid: 4321, createdAt: NOW });
    const symlink = join(root, "linked.lock");
    symlinkSync(target, symlink);
    expect(isDirectAutoUpdateInvocation({ lockPath: symlink, parentPid: 4321, now: NOW })).toBe(
      false,
    );

    const oversized = join(root, "oversized.lock");
    writeFileSync(oversized, "x".repeat(4 * 1024 + 1), { mode: 0o600 });
    expect(isDirectAutoUpdateInvocation({ lockPath: oversized, parentPid: 4321, now: NOW })).toBe(
      false,
    );
  });

  it("rejects directories", () => {
    const root = makeRoot();
    const lockPath = join(root, "auto-update.lock");
    mkdirSync(lockPath);

    expect(isDirectAutoUpdateInvocation({ lockPath, parentPid: 4321, now: NOW })).toBe(false);
  });
});
