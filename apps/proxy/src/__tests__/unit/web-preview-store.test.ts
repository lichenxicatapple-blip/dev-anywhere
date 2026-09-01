import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewSummarySchema } from "@dev-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewStore } from "#src/serve/preview/preview-store.js";
import type { PersistedPreviewDefinition } from "#src/serve/preview/types.js";

const tempPaths: string[] = [];

async function fixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dev-anywhere-preview-store-"));
  tempPaths.push(directory);
  return join(directory, "previews.json");
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function definition(
  overrides: Partial<PersistedPreviewDefinition> = {},
): PersistedPreviewDefinition {
  return {
    previewId: "preview-1",
    name: "localhost:5173",
    source: { kind: "local", url: "http://localhost:5173/admin" },
    tunnelProvider: "cloudflare",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("PreviewStore wire-compatible persistence", () => {
  it("loads definitions without operationId and saves private wire-safe definitions", async () => {
    const path = await fixturePath();
    await writeFile(path, `${JSON.stringify({ version: 1, previews: [definition()] })}\n`);
    const store = new PreviewStore(path);

    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).not.toHaveProperty("operationId");
    expect(PreviewSummarySchema.safeParse({ ...loaded[0], state: "disconnected" }).success).toBe(
      true,
    );

    store.save([{ ...loaded[0]!, operationId: "operation-1" }]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      previews: [{ previewId: "preview-1", operationId: "operation-1" }],
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["non-loopback URL", definition({ source: { kind: "local", url: "http://192.168.1.2" } })],
    ["overlong name", definition({ name: "n".repeat(257) })],
    [
      "overlong static path",
      definition({
        source: { kind: "static", rootPath: `/${"r".repeat(4_096)}`, entryPath: "index.html" },
      }),
    ],
    ["overlong operationId", definition({ operationId: "o".repeat(257) })],
  ])(
    "rejects a syntactically valid file with %s before it can reach the wire",
    async (_label, item) => {
      const path = await fixturePath();
      const raw = `${JSON.stringify({ version: 1, previews: [item] })}\n`;
      await writeFile(path, raw);

      expect(new PreviewStore(path).load()).toEqual([]);
      expect(await readFile(path, "utf8")).toBe(raw);
    },
  );

  it("rejects more definitions than the manager can safely expose", async () => {
    const path = await fixturePath();
    const previews = Array.from({ length: 101 }, (_, index) =>
      definition({ previewId: `preview-${index}` }),
    );
    await writeFile(path, `${JSON.stringify({ version: 1, previews })}\n`);
    expect(new PreviewStore(path).load()).toEqual([]);
  });
});
