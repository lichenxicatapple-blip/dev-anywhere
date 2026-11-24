import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCursorIdeTranscript, scanCursorIdeHistory } from "#src/serve/history/cursor-ide.js";
import { readSessionMessagesPage } from "#src/serve/session-history.js";
import { CursorIdeError } from "#src/common/cursor-ide-cdp.js";

const id = "c3bc842d-97dc-4cec-9cde-00f07cac3f02";
const historyId = `cursor_ide_${id}`;
const dirs: string[] = [];
const originalUserDir = process.env.CURSOR_IDE_USER_DIR;
const originalProjectsDir = process.env.CURSOR_IDE_PROJECTS_DIR;

afterEach(async () => {
  if (originalUserDir === undefined) delete process.env.CURSOR_IDE_USER_DIR;
  else process.env.CURSOR_IDE_USER_DIR = originalUserDir;
  if (originalProjectsDir === undefined) delete process.env.CURSOR_IDE_PROJECTS_DIR;
  else process.env.CURSOR_IDE_PROJECTS_DIR = originalProjectsDir;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cursor-ide-test-"));
  dirs.push(dir);
  const user = join(dir, "User");
  const projects = join(dir, "projects");
  const workspace = join(user, "workspaceStorage", "abc123");
  const transcript = join(projects, "project", "agent-transcripts", id, `${id}.jsonl`);
  await Promise.all([
    mkdir(join(user, "globalStorage"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(join(projects, "project", "agent-transcripts", id), { recursive: true }),
  ]);
  await writeFile(
    join(workspace, "workspace.json"),
    JSON.stringify({ folder: "file:///home/example/project" }),
  );
  await writeFile(
    transcript,
    [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>Hello</user_query>" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "Hello back" }] },
      }),
    ].join("\n"),
  );
  const db = new DatabaseSync(join(user, "globalStorage", "state.vscdb"));
  db.exec(
    "CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, lastUpdatedAt INTEGER, value TEXT, isSubagent INTEGER)",
  );
  db.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?)").run(
    id,
    "abc123",
    123456,
    JSON.stringify({ name: "IDE history" }),
    0,
  );
  db.close();
  process.env.CURSOR_IDE_USER_DIR = user;
  process.env.CURSOR_IDE_PROJECTS_DIR = projects;
  return { projects, transcript };
}

describe("Cursor IDE history", () => {
  it("links IDE metadata to its transcript and reads paginated messages", async () => {
    const { projects, transcript } = await fixture();
    const sessions = await scanCursorIdeHistory(process.env.CURSOR_IDE_USER_DIR, async () => [
      { id, title: "IDE history", section: "example/project" },
    ]);
    expect(sessions).toEqual([
      {
        provider: "cursor",
        id: historyId,
        projectDir: "/home/example/project",
        title: "IDE history",
        cursorIdeGroup: "example/project",
        updatedAt: 123456,
        kind: "main",
        hasConversation: true,
      },
    ]);
    expect(await findCursorIdeTranscript(historyId, projects)).toBe(transcript);
    const last = await readSessionMessagesPage(historyId, { limit: 1 }, "cursor");
    expect(last.messages).toMatchObject([{ role: "assistant", text: "Hello back" }]);
    expect(last.hasMore).toBe(true);
    const previous = await readSessionMessagesPage(
      historyId,
      { before: last.nextBefore, limit: 1 },
      "cursor",
    );
    expect(previous.messages).toMatchObject([{ role: "user", text: "Hello" }]);
  });

  it("omits Cursor task-result prompts that the user did not write", async () => {
    const { transcript } = await fixture();
    const prompt =
      "Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.";
    const shortPrompt =
      "Briefly inform the user about the task result and perform any follow-up actions (if needed).";
    await writeFile(
      transcript,
      [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "<user_query>Hello</user_query>" }] },
        }),
        JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: `<timestamp>Tuesday, Nov 24, 2026, 2:25 PM (UTC+8)</timestamp>\n<user_query>${prompt}</user_query>`,
              },
            ],
          },
        }),
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: `<user_query>${shortPrompt}</user_query>` }],
          },
        }),
        JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: `<user_query>\n客户端引用了这句\n${prompt}\n</user_query>`,
              },
            ],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "Hello back" }] },
        }),
      ].join("\n"),
    );
    const page = await readSessionMessagesPage(historyId, { limit: 10 }, "cursor");
    expect(page.messages.map((message) => message.text)).toEqual([
      "Hello",
      `客户端引用了这句\n${prompt}`,
      "Hello back",
    ]);
  });

  it("reads the workspace transcript when the same id was copied into another project", async () => {
    const { projects } = await fixture();
    const slug = "home-example-project";
    const preferred = join(projects, slug, "agent-transcripts", id, `${id}.jsonl`);
    await mkdir(join(projects, slug, "agent-transcripts", id), { recursive: true });
    await writeFile(
      preferred,
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "from workspace" }] },
      }),
    );
    const page = await readSessionMessagesPage(historyId, { limit: 10 }, "cursor");
    expect(page.messages).toMatchObject([{ role: "assistant", text: "from workspace" }]);
  });

  it("reads composer bubbles when the IDE has not flushed a transcript", async () => {
    await fixture();
    const user = process.env.CURSOR_IDE_USER_DIR;
    if (!user) throw new Error("fixture did not set CURSOR_IDE_USER_DIR");
    const missing = "d6bc842d-97dc-4cec-9cde-00f07cac3f02";
    const db = new DatabaseSync(join(user, "globalStorage", "state.vscdb"));
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insert.run(
      `bubbleId:${missing}:user`,
      JSON.stringify({
        type: 1,
        text: "<user_query>plan this</user_query>",
        createdAt: "2026-11-23T00:00:00.000Z",
      }),
    );
    insert.run(
      `bubbleId:${missing}:plan`,
      JSON.stringify({
        type: 2,
        text: "1. Look at the sidebar",
        createdAt: "2026-11-23T00:00:01.000Z",
      }),
    );
    db.close();
    const page = await readSessionMessagesPage(`cursor_ide_${missing}`, { limit: 10 }, "cursor");
    expect(page.messages).toMatchObject([
      { role: "user", text: "plan this" },
      { role: "assistant", text: "1. Look at the sidebar" },
    ]);
  });

  it("rejects unsafe IDs and ambiguous transcript matches", async () => {
    const { projects, transcript } = await fixture();
    const duplicate = join(projects, "other", "agent-transcripts", id, `${id}.jsonl`);
    await mkdir(join(projects, "other", "agent-transcripts", id), { recursive: true });
    await writeFile(duplicate, await (await import("node:fs/promises")).readFile(transcript));
    expect(await findCursorIdeTranscript("cursor_ide_../../secret", projects)).toBeNull();
    expect(await findCursorIdeTranscript(historyId, projects)).toBeNull();
    // A visible chat remains openable even when its transcript cannot be read safely.
    expect(
      await scanCursorIdeHistory(process.env.CURSOR_IDE_USER_DIR, async () => [
        { id, title: "IDE history", section: "example/project" },
      ]),
    ).toHaveLength(1);
  });

  it("excludes stored sessions that are not displayed by Cursor", async () => {
    await fixture();
    expect(await scanCursorIdeHistory(process.env.CURSOR_IDE_USER_DIR, async () => [])).toEqual([]);
  });

  it("shows a visible row with an actionable reason if its workspace metadata is missing", async () => {
    await fixture();
    const missing = "d6bc842d-97dc-4cec-9cde-00f07cac3f02";
    const sessions = await scanCursorIdeHistory(process.env.CURSOR_IDE_USER_DIR, async () => [
      { id: missing, title: "No workspace", section: "team/project" },
    ]);
    expect(sessions).toMatchObject([
      {
        id: `cursor_ide_${missing}`,
        title: "No workspace",
        cursorIdeGroup: "team/project",
        cursorIdeUnavailable: expect.stringContaining("工作目录"),
      },
    ]);
  });

  it("reports a Cursor connection failure without hiding other providers", async () => {
    await fixture();
    let failure = "";
    const sessions = await scanCursorIdeHistory(
      process.env.CURSOR_IDE_USER_DIR,
      async () => {
        throw new CursorIdeError("无法连接 Cursor IDE，请开启调试端口");
      },
      (message) => {
        failure = message;
      },
    );
    expect(sessions).toEqual([]);
    expect(failure).toBe("无法连接 Cursor IDE，请开启调试端口");
  });
});
