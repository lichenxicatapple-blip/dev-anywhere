import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("daemon relay selection", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "dev-anywhere-daemon-env-"));
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => homeDir };
    });
  });

  afterEach(() => {
    vi.doUnmock("node:os");
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns explicit relay args before persisted desired relay", async () => {
    const { mkdirSync } = await import("node:fs");
    const { RUN_DIR } = await import("#src/common/paths.js");
    const { daemonRelayArgs, setDesiredDaemonRelay } = await import("#src/common/daemon-env.js");
    mkdirSync(RUN_DIR, { recursive: true });

    setDesiredDaemonRelay("cloud");

    expect(daemonRelayArgs()).toEqual(["--relay", "cloud"]);
    expect(daemonRelayArgs("local")).toEqual(["--relay", "local"]);
  });

  it("clears persisted desired relay when relay is omitted", async () => {
    const { mkdirSync } = await import("node:fs");
    const { RUN_DIR } = await import("#src/common/paths.js");
    const { daemonRelayArgs, setDesiredDaemonRelay } = await import("#src/common/daemon-env.js");
    mkdirSync(RUN_DIR, { recursive: true });

    setDesiredDaemonRelay("cloud");
    setDesiredDaemonRelay(undefined);

    expect(daemonRelayArgs()).toEqual([]);
  });
});
