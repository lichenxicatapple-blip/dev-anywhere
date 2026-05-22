import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  normalizeHistoryTitle,
  readSessionMessagesPage,
  readSessionMessages,
  scanSessionHistory,
} from "#src/serve/session-history.js";

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

  it("merges Dev Anywhere restore metadata into native Claude history", async () => {
    writeSession("-test-myproject", "claude-json-1", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Continue chat mode" } }),
    ]);
    const metadataPath = join(testDir, ".dev-anywhere", "state", "history-metadata.json");
    mkdirSync(join(testDir, ".dev-anywhere", "state"), { recursive: true });
    writeFileSync(
      metadataPath,
      JSON.stringify([
        {
          nativeSessionId: "claude-json-1",
          devAnywhereSessionId: "dev-json-1",
          provider: "claude",
          mode: "json",
          cwd: "/test/myproject",
          updatedAt: 123,
        },
      ]),
    );

    const result = await scanSessionHistory({ metadataPath });

    expect(result.find((session) => session.id === "claude-json-1")).toMatchObject({
      id: "claude-json-1",
      provider: "claude",
      preferredMode: "json",
    });
  });

  it("keeps metadata-backed history entries when deduplicating repeated native sessions", async () => {
    writeSession("-test-myproject", "claude-json-old", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Same title" } }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    writeSession("-test-myproject", "claude-unknown-new", [
      JSON.stringify({ type: "user", message: { role: "user", content: "Same title" } }),
    ]);
    const metadataPath = join(testDir, ".dev-anywhere", "state", "history-metadata.json");
    mkdirSync(join(testDir, ".dev-anywhere", "state"), { recursive: true });
    writeFileSync(
      metadataPath,
      JSON.stringify([
        {
          nativeSessionId: "claude-json-old",
          devAnywhereSessionId: "dev-json-old",
          provider: "claude",
          mode: "json",
          cwd: "/test/myproject",
          title: "Renamed JSON chat",
          updatedAt: 123,
        },
      ]),
    );

    const result = await scanSessionHistory({ metadataPath });

    expect(result.find((session) => session.id === "claude-json-old")).toMatchObject({
      id: "claude-json-old",
      title: "Renamed JSON chat",
      projectDir: "/test/myproject",
      preferredMode: "json",
    });
    const unknownSession = result.find((session) => session.id === "claude-unknown-new");
    expect(unknownSession).toMatchObject({
      id: "claude-unknown-new",
      title: "Same title",
    });
    expect(unknownSession).not.toHaveProperty("preferredMode");
  });

  it("falls back to unnamed title when no user text found", async () => {
    writeSession("-test-proj", "notitle99", [
      JSON.stringify({ type: "file-history-snapshot" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hi" } }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("notitle99");
    expect(result[0].title).toBe("未命名会话");
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
    expect(result.find((r) => r.id === "bad")!.title).toBe("未命名会话");
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

  it("filters environment context before using the next real Claude user prompt", async () => {
    writeSession("-test-go", "env1", [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            "<environment_context><cwd>/home/dev/projects/sample-app</cwd><shell>zsh</shell></environment_context>",
        },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "帮我看下这个项目怎么启动" },
      }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("帮我看下这个项目怎么启动");
  });

  it("reads cwd from JSONL instead of decoding directory name", async () => {
    // 模拟 Claude Code 的编码：下划线和路径分隔符都变成连字符
    writeSession("-home-dev-projects-analytics-demo-jobs", "sess1", [
      JSON.stringify({
        type: "progress",
        cwd: "/home/dev/projects/analytics-demo/jobs",
        sessionId: "sess1",
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Check the DAG" } }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].projectDir).toBe("/home/dev/projects/analytics-demo/jobs");
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
              text: "Base directory for this skill: /home/dev/.claude/skills/gsd",
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
    // All user messages are metadata, so the title falls back to the sessionId prefix.
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
    // 没有真实标题时统一显示未命名；同一 provider + projectDir + title 会折叠到最新一条。
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("bbbbbbbb-2222");
    expect(result[0].title).toBe("未命名会话");
  });

  it("includes Codex sessions from ~/.codex/sessions", async () => {
    writeCodexSession("019dfc36-cd43-71d1-bf52-ce65cd40b61d", [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "019dfc36-cd43-71d1-bf52-ce65cd40b61d",
          cwd: "/home/dev/projects/dev-anywhere",
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
      projectDir: "/home/dev/projects/dev-anywhere",
      title: "Use shell to run pwd, then answer DONE.",
    });
  });

  it("filters Codex environment context before using the next real user prompt", async () => {
    writeCodexSession("codex-env", [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-env", cwd: "/home/dev/projects/sample-app" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<environment_context><cwd>/home/dev/projects/sample-app</cwd></environment_context>",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "解释一下这里的测试结构" }],
        },
      }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("解释一下这里的测试结构");
  });

  it("filters Codex internal history summaries before using the next real user prompt", async () => {
    writeCodexSession("codex-summary", [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-summary", cwd: "/home/dev/projects/sample-notes" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "The following is the Codex agent history so far...",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "engine的日志在哪里啊" }],
        },
      }),
    ]);

    const result = await scanSessionHistory();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("engine的日志在哪里啊");
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

describe("normalizeHistoryTitle", () => {
  it("normalizes whitespace and truncates long titles", () => {
    expect(normalizeHistoryTitle("  第一行\n第二行\t第三行  ")).toBe("第一行 第二行 第三行");
    expect(normalizeHistoryTitle("一".repeat(41))).toBe(`${"一".repeat(40)}...`);
  });

  it("filters internal XML-ish context and maintenance slash commands", () => {
    expect(normalizeHistoryTitle("<environment_context>noise</environment_context>")).toBeNull();
    expect(normalizeHistoryTitle("<developer_context>noise</developer_context>")).toBeNull();
    expect(normalizeHistoryTitle("The following is the Codex agent history so far...")).toBeNull();
    expect(normalizeHistoryTitle("/compact")).toBeNull();
    expect(normalizeHistoryTitle("/gsd-progress 2")).toBe("/gsd-progress 2");
  });
});

describe("readSessionMessages", () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `session-messages-test-${randomUUID()}`);
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

  it("preserves markdown newlines when restoring conversation messages", async () => {
    const projectDir = join(testDir, ".claude", "projects", "-test-proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session-md.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "用表格展示下 rust 和 go 之间的区别!" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "| 维度 | Rust | Go |\n|---|---|---|\n| 内存 | 所有权 | GC |",
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );

    const messages = await readSessionMessages("session-md");
    expect(messages[1]).toMatchObject({
      role: "assistant",
      text: "| 维度 | Rust | Go |\n|---|---|---|\n| 内存 | 所有权 | GC |",
    });
  });

  it("reads Claude conversation history in reverse pages with stable cursors", async () => {
    const projectDir = join(testDir, ".claude", "projects", "-test-proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session-paged.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-05-09T00:00:01.000Z",
          message: { role: "user", content: "prompt 1" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-09T00:00:02.000Z",
          message: { role: "assistant", content: "answer 1" },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-05-09T00:00:03.000Z",
          message: { role: "user", content: "prompt 2" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-09T00:00:04.000Z",
          message: { role: "assistant", content: "answer 2" },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-05-09T00:00:05.000Z",
          message: { role: "user", content: "prompt 3" },
        }),
      ].join("\n") + "\n",
    );

    const latest = await readSessionMessagesPage("session-paged", { limit: 2 });
    expect(latest.messages.map((m) => m.text)).toEqual(["answer 2", "prompt 3"]);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextBefore).toBe(latest.messages[0].cursor);

    const older = await readSessionMessagesPage("session-paged", {
      limit: 2,
      before: latest.nextBefore,
    });
    expect(older.messages.map((m) => m.text)).toEqual(["answer 1", "prompt 2"]);
    expect(older.hasMore).toBe(true);
    expect(older.nextBefore).toBe(older.messages[0].cursor);

    const oldest = await readSessionMessagesPage("session-paged", {
      limit: 2,
      before: older.nextBefore,
    });
    expect(oldest.messages.map((m) => m.text)).toEqual(["prompt 1"]);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextBefore).toBeUndefined();
  });

  it.each(["../etc/passwd", "..", "foo/bar", "foo\0bar", "foo bar", "", "with.dot"])(
    "rejects path-unsafe session id %j",
    async (badId) => {
      const messages = await readSessionMessages(badId);
      expect(messages).toEqual([]);
      const page = await readSessionMessagesPage(badId, { limit: 5 });
      expect(page.messages).toEqual([]);
      expect(page.hasMore).toBe(false);
    },
  );
});
