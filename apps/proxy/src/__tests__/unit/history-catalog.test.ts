import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHistoryCatalog } from "#src/serve/history/catalog.js";
import { scanCodexHistory } from "#src/serve/history/codex.js";
import type { NativeHistorySession } from "#src/serve/history/types.js";

const project = resolve("/workspace/my-project");

function native(overrides: Partial<NativeHistorySession> = {}): NativeHistorySession {
  return {
    provider: "codex",
    id: "main-id",
    projectDir: project,
    title: "Same title",
    updatedAt: 100,
    kind: "main",
    hasConversation: true,
    ...overrides,
  };
}

describe("native history catalog identity", () => {
  it("keeps independent IDs even when their displayed titles truncate identically", () => {
    const prefix = "x".repeat(40);
    const result = buildHistoryCatalog([
      native({ id: "first", title: `${prefix} first conversation` }),
      native({ id: "second", title: `${prefix} another conversation` }),
    ]);
    expect(result.map((row) => row.id)).toEqual(["first", "second"]);
    expect(result[0].title).toBe(result[1].title);
    expect(result.every((row) => row.projectDir === project)).toBe(true);
  });

  it("deduplicates copies of one native ID, not names, folders or provider-independent IDs", () => {
    const result = buildHistoryCatalog([
      native({ title: "Before rename" }),
      native({ title: "After rename", projectDir: resolve("/workspace/another"), updatedAt: 200 }),
      native({ provider: "claude" }),
      native({ provider: "kimi" }),
    ]);
    expect(result).toHaveLength(3);
    expect(result.find((row) => row.provider === "codex")).toMatchObject({
      id: "main-id",
      title: "After rename",
      projectDir: resolve("/workspace/another"),
    });
  });

  it("excludes known internal and empty records without guessing the value of short conversations", () => {
    const result = buildHistoryCatalog([
      native({ id: "child", kind: "internal" }),
      native({ id: "metadata-only", hasConversation: false }),
      native({ id: "unknown-origin", kind: "unknown" }),
      native({ id: "one-character", title: "嗯" }),
      native({ id: "image-only", title: undefined }),
    ]);
    expect(result.map((row) => row.id).sort()).toEqual([
      "image-only",
      "one-character",
      "unknown-origin",
    ]);
  });

  it("requires a real absolute project path instead of manufacturing one for grouping or resume", () => {
    const result = buildHistoryCatalog([
      native({ id: "missing", projectDir: undefined }),
      native({ id: "relative", projectDir: "my-project" }),
      native({ id: "nul", projectDir: `${project}\0hidden` }),
      native({ id: "temp", projectDir: join(tmpdir(), "history-fixture") }),
      native({ id: "unsafe/id" }),
      native({ id: "normalized", projectDir: join(project, "nested", "..") }),
    ]);
    expect(result.map((row) => ({ id: row.id, projectDir: row.projectDir }))).toEqual([
      { id: "normalized", projectDir: project },
    ]);
  });
});

describe("Codex native history classification", () => {
  const roots: string[] = [];
  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "codex-history-reader-"));
    roots.push(directory);
    return directory;
  }
  afterEach(() => {
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function write(
    directory: string,
    id: string,
    meta: Record<string, unknown>,
    content: unknown = [{ type: "input_text", text: "Continue working" }],
  ): void {
    const destination = join(directory, "2026", "09", "05");
    mkdirSync(destination, { recursive: true });
    const rows = [
      { type: "session_meta", payload: { id, cwd: project, ...meta } },
      ...(content === null
        ? []
        : [{ type: "response_item", payload: { type: "message", role: "user", content } }]),
    ];
    writeFileSync(
      join(destination, `${id}.jsonl`),
      rows.map((row) => JSON.stringify(row)).join("\n"),
    );
  }

  it("excludes spawned/review agents but keeps user forks with explicit parent metadata", async () => {
    const directory = root();
    write(directory, "main", { source: "cli" });
    write(directory, "child", {
      source: { subagent: { thread_spawn: { parent_thread_id: "main", depth: 1 } } },
      parent_thread_id: "main",
    });
    write(directory, "review", { source: { subagent: "review" } });
    write(directory, "compact", { source: { subagent: "compact" } });
    write(directory, "fork", { source: "cli", forked_from_id: "main", parent_thread_id: "main" });
    write(directory, "editor", { source: "vscode" });
    const records = await scanCodexHistory(directory);
    expect(
      records
        .filter((row) => row.kind === "internal")
        .map((row) => row.id)
        .sort(),
    ).toEqual(["child", "compact", "review"]);
    expect(
      buildHistoryCatalog(records)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["editor", "fork", "main"]);
  });

  it("separates content evidence from title extraction and incomplete metadata", async () => {
    const directory = root();
    write(directory, "metadata-only", { source: "cli" }, null);
    write(directory, "injected-only", {}, [
      { type: "input_text", text: "# AGENTS.md instructions for /workspace" },
      { type: "input_text", text: "<environment_context>metadata</environment_context>" },
    ]);
    write(directory, "unknown-real", {}, [{ type: "input_text", text: "嗯" }]);
    write(directory, "image-only", { source: "cli" }, [
      { type: "input_image", image_url: "fixture" },
    ]);
    write(directory, "missing-cwd", { cwd: undefined });
    write(directory, "no-id", { id: undefined });
    const records = await scanCodexHistory(directory);
    expect(records.find((row) => row.id === "unknown-real")?.kind).toBe("unknown");
    expect(
      buildHistoryCatalog(records)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["image-only", "unknown-real"]);
  });

  it("skips malformed lines without promoting a wholly corrupt file into a session", async () => {
    const directory = root();
    write(directory, "valid", { source: "cli" });
    writeFileSync(join(directory, "broken.jsonl"), "{invalid\n{}\n");
    expect(buildHistoryCatalog(await scanCodexHistory(directory)).map((row) => row.id)).toEqual([
      "valid",
    ]);
  });

  it("recognizes app-server visible event messages as well as response items", async () => {
    const directory = root();
    const rows = [
      { type: "session_meta", payload: { id: "event-only", cwd: project, source: "exec" } },
      { type: "event_msg", payload: { type: "user_message", message: "Continue working" } },
      {
        type: "event_msg",
        payload: { type: "agent_message", message: "I will check the project" },
      },
    ];
    writeFileSync(
      join(directory, "event-only.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n"),
    );
    write(directory, "response-items", { source: "cli" });
    const result = buildHistoryCatalog(await scanCodexHistory(directory));
    expect(result.map((row) => row.id).sort()).toEqual(["event-only", "response-items"]);
    expect(result[0].title).toBe(result[1].title);
  });
});
