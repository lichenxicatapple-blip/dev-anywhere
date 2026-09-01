import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupStalePreviewRuntimes,
  serializePreviewRuntimeMarker,
} from "#src/serve/preview/stale-preview-runtime.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("stale preview runtime cleanup", () => {
  it("removes a dead exact PID runtime but never signals an identity mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-anywhere-stale-preview-"));
    tempPaths.push(root);
    const dead = join(root, "dead-runtime");
    const unrelated = join(root, "unrelated-runtime");
    await Promise.all([mkdir(dead), mkdir(unrelated)]);
    await writeFile(
      join(dead, "runtime.json"),
      serializePreviewRuntimeMarker(2_000_000_000, { provider: "cloudflare" }),
    );
    await writeFile(
      join(unrelated, "runtime.json"),
      serializePreviewRuntimeMarker(process.pid, { provider: "cloudflare" }),
    );
    for (const runtime of [dead, unrelated]) {
      await writeFile(join(runtime, "cloudflared.yml"), "{}\n");
      await writeFile(join(runtime, "cloudflared.pid"), "1\n");
    }

    await cleanupStalePreviewRuntimes(root);

    expect(await exists(dead)).toBe(false);
    expect(await exists(unrelated)).toBe(true);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("never signals a live process from a forged cpolar runtime marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-anywhere-stale-cpolar-"));
    tempPaths.push(root);
    const runtime = join(root, "cpolar-runtime");
    await mkdir(runtime);
    await writeFile(
      join(runtime, "runtime.json"),
      serializePreviewRuntimeMarker(process.pid, {
        provider: "cpolar",
        processStartedAt: "Wed Sep  2 00:00:00 2026",
        executablePath: "/tmp/cpolar",
      }),
    );

    await cleanupStalePreviewRuntimes(root);

    expect(await exists(runtime)).toBe(true);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
});
