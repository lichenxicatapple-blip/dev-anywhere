import { afterEach, describe, expect, it, vi } from "vitest";
import { formatProxyNameForProfile, isProcessAlive } from "#src/serve/service-files.js";

function mockKillError(code: string): void {
  vi.spyOn(process, "kill").mockImplementation((() => {
    const err = new Error(`kill ${code}`) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  }) as typeof process.kill);
}

describe("service files", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the default proxy profile display name unchanged", () => {
    expect(formatProxyNameForProfile("DEV Mac", "default")).toBe("DEV Mac");
  });

  it("adds the profile name for isolated non-default proxy profiles", () => {
    expect(formatProxyNameForProfile("DEV Mac", "local")).toBe("DEV Mac (local)");
  });

  it("treats EPERM while probing a process as alive but inaccessible", () => {
    mockKillError("EPERM");

    expect(isProcessAlive(1234)).toBe(true);
  });

  it("treats ESRCH while probing a process as dead", () => {
    mockKillError("ESRCH");

    expect(isProcessAlive(1234)).toBe(false);
  });
});
