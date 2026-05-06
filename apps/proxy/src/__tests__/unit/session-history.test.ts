import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { scanSessionHistory } from "#src/serve/session-history.js";

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

  function writeCodexSession(sessionId: string, lines: string[]): void {
    const sessionDir = join(testDir, ".codex", "sessions", "2026", "05", "06");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, `rollout-2026-05-06T12-00-00-${sessionId}.jsonl`),
      lines.join("\n") + "\n",
    );
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
    expect(fixBug.provider).toBe("claude");

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
    writeSession("-test-proj", "valid", [JSON.stringify({ type: "user", message: "Hello" })]);
    const projectDir = join(testDir, ".claude", "projects", "-test-proj");
    writeFileSync(join(projectDir, "notes.txt"), "not a session");
    writeFileSync(join(projectDir, "readme.md"), "# readme");

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Hello");
  });

  it("handles malformed JSONL gracefully", async () => {
    writeSession("-test-proj", "good", [JSON.stringify({ type: "user", message: "Good session" })]);
    const projectDir = join(testDir, ".claude", "projects", "-test-proj");
    writeFileSync(join(projectDir, "bad.jsonl"), "{ not valid json }}}\n");

    const result = await scanSessionHistory();
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.id === "good")!.title).toBe("Good session");
    expect(result.find((r) => r.id === "bad")!.title).toBe("bad");
  });

  it("sorts results by updatedAt descending", async () => {
    writeSession("-test-proj", "older", [JSON.stringify({ type: "user", message: "Older" })]);
    await new Promise((r) => setTimeout(r, 50));
    writeSession("-test-proj", "newer", [JSON.stringify({ type: "user", message: "Newer" })]);

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

  it("extracts slash command from XML tags, skips pure XML noise and /clear", async () => {
    writeSession("-test-proj", "skip", [
      JSON.stringify({ type: "user", message: "<some-xml>noise</some-xml>" }),
      JSON.stringify({
        type: "user",
        message: "<command-name>/clear</command-name><command-args></command-args>",
      }),
      JSON.stringify({
        type: "user",
        message: "<command-name>/gsd-progress</command-name><command-args>2</command-args>",
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Real question" } }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("/gsd-progress 2");
  });

  it("reads cwd from JSONL instead of decoding directory name", async () => {
    // 模拟 Claude Code 的编码：下划线和路径分隔符都变成连字符
    writeSession("-Users-admin-workspace-bmo_intraday_statement-airflow_dags_sbl", "sess1", [
      JSON.stringify({
        type: "progress",
        cwd: "/Users/admin/workspace/bmo_intraday_statement/airflow_dags_sbl",
        sessionId: "sess1",
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Check the DAG" } }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].projectDir).toBe(
      "/Users/admin/workspace/bmo_intraday_statement/airflow_dags_sbl",
    );
    expect(result[0].title).toBe("Check the DAG");
  });

  it("skips isMeta user messages for title extraction", async () => {
    writeSession("-test-proj", "meta1", [
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Base directory for this skill: /Users/admin/.claude/skills/gsd",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "What is this project about?" },
      }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("What is this project about?");
  });

  it("deduplicates sessions with same title + projectDir, keeps newest", async () => {
    writeSession("-test-proj", "old1", [
      JSON.stringify({ type: "progress", cwd: "/test/proj", sessionId: "old1" }),
      JSON.stringify({ type: "user", message: "Same question" }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    writeSession("-test-proj", "new1", [
      JSON.stringify({ type: "progress", cwd: "/test/proj", sessionId: "new1" }),
      JSON.stringify({ type: "user", message: "Same question" }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new1");
    expect(result[0].title).toBe("Same question");
  });

  it("does NOT dedup when all user messages are isMeta and titles fall back to unique session IDs", async () => {
    // 模拟 MaoGe 场景：所有 user 消息都是 isMeta，title 回退到 sessionId 前缀
    writeSession("-test-proj", "aaaaaaaa-1111", [
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<command-name>/clear</command-name>" },
      }),
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [{ type: "text", text: "Base directory for this skill" }],
        },
      }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    writeSession("-test-proj", "bbbbbbbb-2222", [
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<command-name>/clear</command-name>" },
      }),
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [{ type: "text", text: "Base directory for this skill" }],
        },
      }),
    ]);

    const result = await scanSessionHistory();
    // 两个 session 的 title 分别是 "aaaaaaaa" 和 "bbbbbbbb"，不同，不去重
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("bbbbbbbb");
    expect(result[1].title).toBe("aaaaaaaa");
  });

  it("includes Codex sessions from ~/.codex/sessions", async () => {
    writeCodexSession("019dfc36-cd43-71d1-bf52-ce65cd40b61d", [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "019dfc36-cd43-71d1-bf52-ce65cd40b61d",
          cwd: "/Users/admin/workspace/cc_anywhere",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use shell to run pwd, then answer DONE." }],
        },
      }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "019dfc36-cd43-71d1-bf52-ce65cd40b61d",
      provider: "codex",
      projectDir: "/Users/admin/workspace/cc_anywhere",
      title: "Use shell to run pwd, then answer DONE.",
    });
  });

  it("keeps Claude and Codex entries with the same title and cwd separate", async () => {
    writeSession("-same-proj", "claude1", [
      JSON.stringify({ type: "progress", cwd: "/same/proj", sessionId: "claude1" }),
      JSON.stringify({ type: "user", message: "Same title" }),
    ]);
    writeCodexSession("codex1", [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex1", cwd: "/same/proj" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Same title" }],
        },
      }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.provider).sort()).toEqual(["claude", "codex"]);
  });
});
