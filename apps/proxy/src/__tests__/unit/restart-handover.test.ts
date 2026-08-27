import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLiveLocalPtySessionIds,
  waitForSessionHandover,
} from "#src/common/restart-handover.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("restart session handover", () => {
  it("tracks only live local-terminal PTYs from persisted state", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-handover-"));
    dirs.push(dir);
    const path = join(dir, "sessions.json");
    writeFileSync(
      path,
      JSON.stringify([
        { id: "local-live", mode: "pty", ptyOwner: "local-terminal", pid: 11 },
        { id: "hosted-live", mode: "pty", ptyOwner: "proxy-hosted", pid: 12 },
        { id: "json-live", mode: "json", pid: 13 },
        { id: "local-dead", mode: "pty", ptyOwner: "local-terminal", pid: 14 },
      ]),
    );

    expect(
      readLiveLocalPtySessionIds(path, (pid) =>
        pid === 14 ? { status: "not-found", code: "ESRCH", message: "gone" } : { status: "alive" },
      ),
    ).toEqual(["local-live"]);
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
