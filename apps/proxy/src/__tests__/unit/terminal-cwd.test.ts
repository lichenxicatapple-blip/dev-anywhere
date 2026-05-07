import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTerminalCwd } from "#src/terminal/cwd.js";

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dev-anywhere-${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveTerminalCwd", () => {
  it("prefers explicit DEV_ANYWHERE_CWD", () => {
    const explicit = tempDir("explicit");
    const init = tempDir("init");

    expect(
      resolveTerminalCwd({
        DEV_ANYWHERE_CWD: explicit,
        INIT_CWD: init,
      }),
    ).toBe(explicit);
  });

  it("falls back through INIT_CWD and PWD before process cwd", () => {
    const init = tempDir("init");
    const pwd = tempDir("pwd");

    expect(resolveTerminalCwd({ INIT_CWD: init, PWD: pwd })).toBe(init);
    expect(resolveTerminalCwd({ INIT_CWD: "/missing", PWD: pwd })).toBe(pwd);
  });

  it("ignores invalid candidates", () => {
    expect(
      resolveTerminalCwd({
        DEV_ANYWHERE_CWD: "/missing-dev-anywhere-cwd",
        INIT_CWD: "/missing-init-cwd",
        PWD: "/missing-pwd",
      }),
    ).toBe(process.cwd());
  });
});
