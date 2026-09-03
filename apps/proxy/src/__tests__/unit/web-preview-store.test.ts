import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    operationId: "operation-1",
    operationFingerprint: "a".repeat(64),
    ...overrides,
  };
}

describe("PreviewStore persistence", () => {
  it("rejects definitions without operationId and saves the current strict shape", async () => {
    const path = await fixturePath();
    const incompleteDefinition = { ...definition(), operationId: undefined };
    await writeFile(path, `${JSON.stringify({ version: 1, previews: [incompleteDefinition] })}\n`);
    const store = new PreviewStore(path);

    expect(store.load()).toEqual([]);

    const current = definition();
    store.save([current]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      previews: [
        {
          previewId: "preview-1",
          operationId: "operation-1",
          operationFingerprint: "a".repeat(64),
        },
      ],
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects unknown persisted fields instead of interpreting another shape", async () => {
    const path = await fixturePath();
    await writeFile(
      path,
      `${JSON.stringify({ version: 1, previews: [{ ...definition(), retiredField: true }] })}\n`,
    );

    expect(new PreviewStore(path).load()).toEqual([]);
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
    ["invalid operation fingerprint", definition({ operationFingerprint: "not-a-fingerprint" })],
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
