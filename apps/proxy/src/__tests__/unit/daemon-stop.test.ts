import { describe, expect, it, vi } from "vitest";
import { waitForProcessExit } from "#src/common/daemon-stop.js";

describe("daemon stop wait", () => {
  it("does not report success until the old process is actually gone", async () => {
    const probe = vi
      .fn()
      .mockReturnValueOnce({ status: "alive" })
      .mockReturnValueOnce({ status: "alive" })
      .mockReturnValueOnce({ status: "not-found" });
    const wait = vi.fn(async () => {});

    await expect(
      waitForProcessExit(42, { timeoutMs: 500, pollMs: 100, probe, wait }),
    ).resolves.toBe("exited");
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("refuses to guess when the process can no longer be probed", async () => {
    await expect(
      waitForProcessExit(42, {
        timeoutMs: 500,
        probe: () => ({ status: "permission-denied", code: "EPERM", message: "denied" }),
        wait: async () => {},
      }),
    ).resolves.toBe("unverifiable");
  });

  it("times out while the old daemon remains alive", async () => {
    await expect(
      waitForProcessExit(42, {
        timeoutMs: 200,
        pollMs: 100,
        probe: () => ({ status: "alive" }),
        wait: async () => {},
      }),
    ).resolves.toBe("timed-out");
  });
});
