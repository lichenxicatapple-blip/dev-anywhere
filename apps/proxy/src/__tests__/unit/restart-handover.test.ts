import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLiveLocalPtySessionIds,
  waitForSessionHandover,
} from "#src/common/restart-handover.js";
import {
  readSessionRuntimeIpcVersions,
  writeSessionRuntimeIpcVersions,
} from "#src/common/session-runtime-ipc-version.js";
import {
  TERMINAL_IPC_PROTOCOL_VERSION,
  WORKER_IPC_PROTOCOL_VERSION,
} from "#src/ipc/ipc-protocol.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("restart session handover", () => {
  const runtimeVersions = {
    terminal: TERMINAL_IPC_PROTOCOL_VERSION,
    worker: WORKER_IPC_PROTOCOL_VERSION,
  };

  it.each([0, 1])("tracks local PTYs independently of a worker-version offset of %s", (offset) => {
    const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-handover-"));
    dirs.push(dir);
    const path = join(dir, "sessions.json");
    const versionPath = join(dir, "session-runtime-ipc-version");
    writeSessionRuntimeIpcVersions(versionPath, {
      ...runtimeVersions,
      worker: WORKER_IPC_PROTOCOL_VERSION + offset,
    });
    writeFileSync(
      path,
      JSON.stringify([
        {
          id: "local-live",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          ptyOwner: "local-terminal",
          cwd: "/tmp",
          pid: 11,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "hosted-live",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          ptyOwner: "proxy-hosted",
          cwd: "/tmp",
          pid: 12,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "json-live",
          kind: "agent",
          mode: "json",
          provider: "claude",
          cwd: "/tmp",
          pid: 13,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "local-dead",
          kind: "terminal",
          mode: "pty",
          provider: "claude",
          ptyOwner: "local-terminal",
          cwd: "/tmp",
          pid: 14,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );

    expect(
      readLiveLocalPtySessionIds(path, versionPath, runtimeVersions, (pid) =>
        pid === 14 ? { status: "not-found", code: "ESRCH", message: "gone" } : { status: "alive" },
      ),
    ).toEqual(["local-live"]);
  });

  it("does not wait for incomplete records even when the runtime marker matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-handover-"));
    dirs.push(dir);
    const sessionsPath = join(dir, "sessions.json");
    const versionPath = join(dir, "session-runtime-ipc-version");
    writeSessionRuntimeIpcVersions(versionPath, runtimeVersions);
    writeFileSync(
      sessionsPath,
      JSON.stringify([
        { id: "missing-current-fields", mode: "pty", ptyOwner: "local-terminal", pid: 11 },
      ]),
    );

    expect(
      readLiveLocalPtySessionIds(sessionsPath, versionPath, runtimeVersions, () => ({
        status: "alive",
      })),
    ).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-version"],
    [
      "incompatible terminal generation",
      JSON.stringify({
        terminal: TERMINAL_IPC_PROTOCOL_VERSION - 1,
        worker: WORKER_IPC_PROTOCOL_VERSION,
      }),
    ],
  ])("does not wait for local PTYs when the protocol marker is %s", (_label, marker) => {
    const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-handover-"));
    dirs.push(dir);
    const sessionsPath = join(dir, "sessions.json");
    const versionPath = join(dir, "session-runtime-ipc-version");
    writeFileSync(
      sessionsPath,
      JSON.stringify([
        {
          id: "local-live",
          kind: "agent",
          mode: "pty",
          provider: "kimi",
          ptyOwner: "local-terminal",
          cwd: "/tmp",
          pid: 11,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    if (marker !== undefined) writeFileSync(versionPath, marker);

    expect(
      readLiveLocalPtySessionIds(sessionsPath, versionPath, runtimeVersions, () => ({
        status: "alive",
      })),
    ).toEqual([]);
  });

  it("round-trips the session runtime IPC generation marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-handover-"));
    dirs.push(dir);
    const versionPath = join(dir, "nested", "session-runtime-ipc-version");

    expect(readSessionRuntimeIpcVersions(versionPath)).toBeNull();
    writeSessionRuntimeIpcVersions(versionPath, runtimeVersions);
    expect(readSessionRuntimeIpcVersions(versionPath)).toEqual(runtimeVersions);
  });

  it("waits until every expected terminal re-registers", async () => {
    const loadActiveSessionIds = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["one"])
      .mockResolvedValueOnce(["one", "two"]);

    await expect(
      waitForSessionHandover({
        expectedSessionIds: ["one", "two"],
        loadActiveSessionIds,
        timeoutMs: 500,
        pollMs: 100,
        wait: async () => {},
      }),
    ).resolves.toEqual([]);
  });

  it("returns the exact terminals still missing at the deadline", async () => {
    await expect(
      waitForSessionHandover({
        expectedSessionIds: ["one", "two"],
        loadActiveSessionIds: async () => ["one"],
        timeoutMs: 200,
        pollMs: 100,
        wait: async () => {},
      }),
    ).resolves.toEqual(["two"]);
  });

  it("counts slow status probes against the real timeout", async () => {
    vi.useFakeTimers();
    const loadActiveSessionIds = vi.fn(async (timeoutMs: number) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return null;
    });

    const result = waitForSessionHandover({
      expectedSessionIds: ["one"],
      loadActiveSessionIds,
      timeoutMs: 2_000,
      pollMs: 250,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual(["one"]);
    expect(loadActiveSessionIds).toHaveBeenCalledTimes(2);
    expect(loadActiveSessionIds.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([1_000, 750]);
    vi.useRealTimers();
  });
});
