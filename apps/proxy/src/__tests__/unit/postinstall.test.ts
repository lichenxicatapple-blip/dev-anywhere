import { readFileSync } from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("../../../scripts/postinstall.cjs", import.meta.url), "utf8");

describe("cross-platform package installation", () => {
  it.each(["win32", "linux"])("does not execute POSIX setup on %s", (platform) => {
    const require = vi.fn();
    runInNewContext(script, { process: { platform }, require });
    expect(require).not.toHaveBeenCalled();
  });

  it("adds executable permission only to macOS spawn helpers", () => {
    const chmodSync = vi.fn();
    const fs = {
      readdirSync: () => ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"],
      statSync: () => ({ mode: 0o644 }),
      chmodSync,
    };
    const require = Object.assign((name: string) => (name === "node:fs" ? fs : path.posix), {
      resolve: () => "/package/node-pty/package.json",
    });
    runInNewContext(script, { process: { platform: "darwin" }, require, console });
    expect(chmodSync.mock.calls).toEqual([
      ["/package/node-pty/prebuilds/darwin-arm64/spawn-helper", 0o755],
      ["/package/node-pty/prebuilds/darwin-x64/spawn-helper", 0o755],
    ]);
  });
});
