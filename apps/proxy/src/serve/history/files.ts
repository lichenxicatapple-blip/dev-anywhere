import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Iterators also close the file when a reader has enough facts and breaks early. */
export async function* readJsonlRecords(filePath: string): AsyncGenerator<Record<string, unknown>> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) return;
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown> | null;
      try {
        record = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (record) yield record;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function collectFiles(root: string, matches: (name: string) => boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await collectFiles(child, matches)));
    else if (entry.isFile() && matches(entry.name)) result.push(child);
  }
  return result.sort();
}

export function collectJsonlFiles(root: string): Promise<string[]> {
  return collectFiles(root, (name) => name.endsWith(".jsonl"));
}

export function collectFilesNamed(root: string, filename: string): Promise<string[]> {
  return collectFiles(root, (name) => name === filename);
}
