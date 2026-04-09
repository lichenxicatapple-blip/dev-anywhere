import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { scanSessionHistory } from "../session-history.js";

// 用临时目录模拟 ~/.claude/projects/ 结构进行测试
// 需要 mock homedir 让 scanSessionHistory 扫描测试目录

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
    } catch {}
  });

  it("returns empty array when ~/.claude/projects/ does not exist", async () => {
    const result = await scanSessionHistory();
    expect(result).toEqual([]);
  });

  it("returns empty array when projects dir exists but has no sessions", async () => {
    const projectsDir = join(testDir, ".claude", "projects", "-Users-test-project");
    mkdirSync(projectsDir, { recursive: true });

    const result = await scanSessionHistory();
    expect(result).toEqual([]);
  });

  it("extracts session ID, title, project directory, and updatedAt from session files", async () => {
    const encodedProject = "-Users-admin-workspace-myproject";
    const sessionsDir = join(testDir, ".claude", "projects", encodedProject, ".sessions");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(
      join(sessionsDir, "abc123.json"),
      JSON.stringify({ title: "Fix login bug" }),
    );
    writeFileSync(
      join(sessionsDir, "def456.json"),
      JSON.stringify({ title: "Add new feature" }),
    );

    const result = await scanSessionHistory();
    expect(result).toHaveLength(2);

    const ids = result.map((r) => r.id);
    expect(ids).toContain("abc123");
    expect(ids).toContain("def456");

    const fixBug = result.find((r) => r.id === "abc123")!;
    expect(fixBug.title).toBe("Fix login bug");
    expect(fixBug.projectDir).toBe("/Users/admin/workspace/myproject");
    expect(fixBug.updatedAt).toBeGreaterThan(0);
  });

  it("handles session files with missing title by using session ID", async () => {
    const encodedProject = "-Users-test-proj";
    const sessionsDir = join(testDir, ".claude", "projects", encodedProject, ".sessions");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(
      join(sessionsDir, "notitle.json"),
      JSON.stringify({ someOtherField: "value" }),
    );

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("notitle");
    expect(result[0].title).toBe("notitle");
  });

  it("skips non-JSON files", async () => {
    const encodedProject = "-Users-test-proj";
    const sessionsDir = join(testDir, ".claude", "projects", encodedProject, ".sessions");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, "session1.json"), JSON.stringify({ title: "Valid" }));
    writeFileSync(join(sessionsDir, "notes.txt"), "not a session");
    writeFileSync(join(sessionsDir, "readme.md"), "# readme");

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Valid");
  });

  it("handles malformed JSON gracefully", async () => {
    const encodedProject = "-Users-test-proj";
    const sessionsDir = join(testDir, ".claude", "projects", encodedProject, ".sessions");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, "good.json"), JSON.stringify({ title: "Good" }));
    writeFileSync(join(sessionsDir, "bad.json"), "{ this is not valid json }}}");

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Good");
  });

  it("sorts results by updatedAt descending", async () => {
    const encodedProject = "-Users-test-proj";
    const sessionsDir = join(testDir, ".claude", "projects", encodedProject, ".sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // 先写 older，再写 newer，newer 的 mtime 更大
    writeFileSync(join(sessionsDir, "older.json"), JSON.stringify({ title: "Older" }));
    // 小延迟确保 mtime 不同
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(sessionsDir, "newer.json"), JSON.stringify({ title: "Newer" }));

    const result = await scanSessionHistory();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("newer");
    expect(result[1].id).toBe("older");
  });
});
