import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { scanSessionHistory } from "#src/session-history.js";

// 用临时目录模拟 ~/.claude/projects/ 结构进行测试
// 实际结构: ~/.claude/projects/<encoded-path>/<session-id>.jsonl

describe("scanSessionHistory", () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `session-history-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // 清理阶段安全忽略
    }
  });

  function writeSession(encodedProject: string, sessionId: string, lines: string[]): void {
    const projectDir = join(testDir, ".claude", "projects", encodedProject);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  it("returns empty array when ~/.claude/projects/ does not exist", async () => {
    const result = await scanSessionHistory();
    expect(result).toEqual([]);
  });

  it("returns empty array when projects dir exists but has no sessions", async () => {
    const projectsDir = join(testDir, ".claude", "projects", "-test-project");
    mkdirSync(projectsDir, { recursive: true });

    const result = await scanSessionHistory();
    expect(result).toEqual([]);
  });

  it("extracts session ID and title from JSONL user messages", async () => {
    writeSession("-test-myproject", "abc123", [
      JSON.stringify({ type: "file-history-snapshot" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Fix login bug" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "OK" } }),
    ]);
    writeSession("-test-myproject", "def456", [
      JSON.stringify({ type: "user", message: "Add new feature" }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(2);

    const ids = result.map((r) => r.id);
    expect(ids).toContain("abc123");
    expect(ids).toContain("def456");

    const fixBug = result.find((r) => r.id === "abc123")!;
    expect(fixBug.title).toBe("Fix login bug");
    expect(fixBug.updatedAt).toBeGreaterThan(0);

    const addFeature = result.find((r) => r.id === "def456")!;
    expect(addFeature.title).toBe("Add new feature");
  });

  it("falls back to session ID prefix when no user text found", async () => {
    writeSession("-test-proj", "notitle99", [
      JSON.stringify({ type: "file-history-snapshot" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hi" } }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("notitle99");
    expect(result[0].title).toBe("notitle9");
  });

  it("skips non-jsonl files", async () => {
    writeSession("-test-proj", "valid", [
      JSON.stringify({ type: "user", message: "Hello" }),
    ]);
    const projectDir = join(testDir, ".claude", "projects", "-test-proj");
    writeFileSync(join(projectDir, "notes.txt"), "not a session");
    writeFileSync(join(projectDir, "readme.md"), "# readme");

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Hello");
  });

  it("handles malformed JSONL gracefully", async () => {
    writeSession("-test-proj", "good", [
      JSON.stringify({ type: "user", message: "Good session" }),
    ]);
    const projectDir = join(testDir, ".claude", "projects", "-test-proj");
    writeFileSync(join(projectDir, "bad.jsonl"), "{ not valid json }}}\n");

    const result = await scanSessionHistory();
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.id === "good")!.title).toBe("Good session");
    expect(result.find((r) => r.id === "bad")!.title).toBe("bad");
  });

  it("sorts results by updatedAt descending", async () => {
    writeSession("-test-proj", "older", [
      JSON.stringify({ type: "user", message: "Older" }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    writeSession("-test-proj", "newer", [
      JSON.stringify({ type: "user", message: "Newer" }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("newer");
    expect(result[1].id).toBe("older");
  });

  it("extracts title from array-format user messages", async () => {
    writeSession("-test-proj", "arr", [
      JSON.stringify({ type: "user", message: [{ type: "text", text: "Array format message" }] }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Array format message");
  });

  it("skips user messages starting with < or /", async () => {
    writeSession("-test-proj", "skip", [
      JSON.stringify({ type: "user", message: "<command>clear</command>" }),
      JSON.stringify({ type: "user", message: "/help" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Real question" } }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Real question");
  });
});
