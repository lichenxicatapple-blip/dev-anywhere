import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("daemon env selection", () => {
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

  it("returns explicit env args before persisted desired env", async () => {
    const { mkdirSync } = await import("node:fs");
    const { RUN_DIR } = await import("#src/common/paths.js");
    const { daemonEnvArgs, setDesiredDaemonEnv } = await import("#src/common/daemon-env.js");
    mkdirSync(RUN_DIR, { recursive: true });

    setDesiredDaemonEnv("cloud");

    expect(daemonEnvArgs()).toEqual(["--env", "cloud"]);
    expect(daemonEnvArgs("local")).toEqual(["--env", "local"]);
  });

  it("clears persisted desired env when env is omitted", async () => {
    const { mkdirSync } = await import("node:fs");
    const { RUN_DIR } = await import("#src/common/paths.js");
    const { daemonEnvArgs, setDesiredDaemonEnv } = await import("#src/common/daemon-env.js");
    mkdirSync(RUN_DIR, { recursive: true });

    setDesiredDaemonEnv("cloud");
    setDesiredDaemonEnv(undefined);

    expect(daemonEnvArgs()).toEqual([]);
  });
});
