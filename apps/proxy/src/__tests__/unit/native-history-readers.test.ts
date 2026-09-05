import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanClaudeHistory } from "#src/serve/history/claude.js";
import { scanKimiHistory } from "#src/serve/history/kimi.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-history-readers-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJsonl(path: string, records: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return path;
}

function claude(id: string, records: unknown[]): string {
  return writeJsonl(join(root, "claude", "-encoded-path-with-hyphens", `${id}.jsonl`), records);
}

function kimi(id: string, records: unknown[] = [], state: Record<string, unknown> = {}): string {
  const directory = join(root, "kimi", "workspace", id);
  const wire = writeJsonl(join(directory, "agents", "main", "wire.jsonl"), records);
  writeFileSync(
    join(directory, "state.json"),
    JSON.stringify({ id, cwd: join(root, "project"), createdAt: 1, updatedAt: 2, ...state }),
  );
  return wire;
}

describe("Claude native history reader", () => {
  it("reads native command envelopes without promoting maintenance output to conversation", async () => {
    claude("command", [
      { type: "user", message: { content: "<some-xml>noise</some-xml>" } },
      { type: "user", message: { content: "<command-name>/clear</command-name>" } },
      {
        type: "user",
        message: {
          content: "<command-name>/gsd-progress</command-name><command-args>2</command-args>",
        },
      },
    ]);
    claude("maintenance", [
      { type: "user", message: "<local-command-stdout>Compacted</local-command-stdout>" },
      { type: "user", message: "<command-name>/clear</command-name>" },
    ]);
    const entries = await scanClaudeHistory(join(root, "claude"));
    expect(entries.find((entry) => entry.id === "command")).toMatchObject({
      title: "/gsd-progress 2",
      hasConversation: true,
    });
    expect(entries.find((entry) => entry.id === "maintenance")?.hasConversation).toBe(false);
  });

  it("keeps real cwd and raw titles without merging independent native ids", async () => {
    const cwd = join(root, "actual-project-with-hyphens");
    const title = "同一个很长的问题".repeat(20);
    for (const id of ["first", "second"])
      claude(id, [
        { type: "user", isSidechain: false, cwd, message: { role: "user", content: title } },
      ]);
    const entries = await scanClaudeHistory(join(root, "claude"));
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id).sort()).toEqual(["first", "second"]);
    for (const entry of entries)
      expect(entry).toMatchObject({
        provider: "claude",
        projectDir: cwd,
        title,
        kind: "main",
        hasConversation: true,
      });
  });

  it("does not reconstruct a missing cwd or assert a main origin without native flags", async () => {
    claude("unknown", [{ type: "user", message: { content: "字" } }]);
    const [entry] = await scanClaudeHistory(join(root, "claude"));
    expect(entry).toMatchObject({
      id: "unknown",
      kind: "unknown",
      hasConversation: true,
    });
    expect(entry.title).toBeUndefined();
    expect(entry.projectDir).toBeUndefined();
  });

  it("uses explicit sidechain flags instead of names or directory heuristics", async () => {
    claude("agent-looking-name", [
      { type: "user", isSidechain: false, message: { content: "主对话" } },
    ]);
    claude("normal-name", [{ type: "user", isSidechain: true, message: { content: "内部对话" } }]);
    claude("late-source", [
      { type: "user", message: { content: "内容" } },
      { type: "assistant", isSidechain: true, message: { content: "答" } },
    ]);
    const entries = await scanClaudeHistory(join(root, "claude"));
    expect(entries.find((entry) => entry.id === "agent-looking-name")?.kind).toBe("main");
    expect(
      entries
        .filter((entry) => entry.kind === "internal")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["late-source", "normal-name"]);
  });

  it("counts image-only messages without inventing a text title", async () => {
    claude("image", [
      {
        type: "user",
        isSidechain: false,
        message: {
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aA==" } },
          ],
        },
      },
    ]);
    const [entry] = await scanClaudeHistory(join(root, "claude"));
    expect(entry.hasConversation).toBe(true);
    expect(entry.title).toBeUndefined();
  });

  it("does not count metadata, injected summaries or tool payloads as conversation", async () => {
    claude("metadata", [
      { type: "file-history-snapshot", cwd: join(root, "project") },
      { type: "user", isMeta: true, message: { content: "Generated instructions" } },
      { type: "user", message: { content: "<environment_context>injected</environment_context>" } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", input: { text: "tool input" } }] },
      },
    ]);
    expect((await scanClaudeHistory(join(root, "claude")))[0].hasConversation).toBe(false);
  });

  it("skips malformed records while preserving later real conversation and native mtime", async () => {
    const path = claude("partial", []);
    writeFileSync(path, `broken\nnull\n[]\n${JSON.stringify({ type: "user", message: "好的" })}\n`);
    utimesSync(path, new Date(10_000), new Date(20_000));
    const [entry] = await scanClaudeHistory(join(root, "claude"));
    expect(entry).toMatchObject({
      id: "partial",
      title: "好的",
      hasConversation: true,
      updatedAt: 20_000,
    });
  });

  it("ignores nested agent directories and symlink files or project directories", async () => {
    const outside = writeJsonl(join(root, "outside.jsonl"), [{ type: "user", message: "外部" }]);
    claude("empty", []);
    const project = join(root, "claude", "-encoded-path-with-hyphens");
    writeJsonl(join(project, "subagents", "internal.jsonl"), [{ type: "user", message: "内部" }]);
    symlinkSync(outside, join(project, "linked.jsonl"));
    symlinkSync(project, join(root, "claude", "linked-project"), "junction");
    expect((await scanClaudeHistory(join(root, "claude"))).map((entry) => entry.id)).toEqual([
      "empty",
    ]);
  });
});

describe("Kimi native history reader", () => {
  it("reads the durable user turn used by both terminal and ACP sessions", async () => {
    const title = "需要保留完整的原始问题".repeat(15);
    kimi(
      "session_turn",
      [
        { type: "metadata" },
        {
          type: "turn.prompt",
          agentId: "main",
          origin: { kind: "user" },
          input: [{ type: "text", text: "字" }],
        },
      ],
      { title, updatedAt: 123 },
    );
    expect(await scanKimiHistory(join(root, "kimi"))).toEqual([
      {
        provider: "kimi",
        id: "session_turn",
        projectDir: join(root, "project"),
        title,
        updatedAt: 123,
        kind: "main",
        hasConversation: true,
      },
    ]);
  });

  it("recognizes WireMessageRecord TurnBegin user input, not lifecycle metadata", async () => {
    kimi("session_wire", [
      { type: "metadata", protocol_version: "1.0" },
      { timestamp: 1, message: { type: "StepBegin", payload: { n: 1 } } },
      { timestamp: 2, message: { type: "TurnBegin", payload: { user_input: "问" } } },
    ]);
    const [entry] = await scanKimiHistory(join(root, "kimi"));
    expect(entry.hasConversation).toBe(true);
    expect(entry.title).toBeUndefined();
  });

  it("accepts durable conversation messages and assistant text parts", async () => {
    kimi("session_message", [
      {
        type: "context.append_message",
        agentId: "main",
        message: {
          role: "user",
          content: [{ type: "text", text: "问题" }],
          origin: { kind: "user" },
        },
      },
    ]);
    kimi("session_reply", [
      {
        type: "context.append_loop_event",
        agentId: "main",
        event: { type: "content.part", part: { type: "text", text: "答" } },
      },
    ]);
    expect(
      (await scanKimiHistory(join(root, "kimi"))).every((entry) => entry.hasConversation),
    ).toBe(true);
  });

  it("accepts image-only user input", async () => {
    kimi("session_image", [
      {
        type: "turn.prompt",
        input: [{ type: "image_url", image_url: { url: "data:image/png;base64,aA==" } }],
      },
    ]);
    const [entry] = await scanKimiHistory(join(root, "kimi"));
    expect(entry.hasConversation).toBe(true);
    expect(entry.title).toBeUndefined();
  });

  it("does not manufacture conversation from state, accepted prompts, thinking or internal origins", async () => {
    kimi(
      "session_metadata",
      [
        { type: "prompt.accepted", content: [{ type: "text", text: "仅传输回执" }] },
        {
          type: "turn.prompt",
          origin: { kind: "compaction" },
          input: [{ type: "text", text: "摘要" }],
        },
        { type: "context.append_message", message: { role: "tool", content: "工具结果" } },
        {
          type: "context.append_loop_event",
          event: { type: "content.part", part: { type: "think", think: "思考" } },
        },
      ],
      { title: "标题不是内容", lastPrompt: "旧提示也不是内容" },
    );
    expect((await scanKimiHistory(join(root, "kimi")))[0].hasConversation).toBe(false);
  });

  it("excludes archived state and invalid identity without requiring or guessing cwd", async () => {
    kimi("session_archived", [{ type: "turn.prompt", input: "问" }], { archived: true });
    kimi("session_wrong_id", [{ type: "turn.prompt", input: "问" }], { id: "different_id" });
    kimi("session_no_cwd", [{ type: "turn.prompt", input: "问" }], { cwd: undefined });
    const entries = await scanKimiHistory(join(root, "kimi"));
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("session_no_cwd");
    expect(entries[0].projectDir).toBeUndefined();
  });

  it("never promotes child agents or nested agent state to a main conversation", async () => {
    const wire = kimi("session_parent", [
      { type: "turn.prompt", agentId: "worker", input: "子代理输入" },
      {
        message: {
          type: "SubagentEvent",
          payload: { message: { type: "TurnBegin", payload: { user_input: "子代理输入" } } },
        },
      },
    ]);
    const child = join(dirname(dirname(wire)), "worker");
    writeJsonl(join(child, "wire.jsonl"), [{ type: "turn.prompt", input: "内部" }]);
    writeFileSync(
      join(child, "state.json"),
      JSON.stringify({ id: "worker", title: "内部", cwd: root }),
    );
    const entries = await scanKimiHistory(join(root, "kimi"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "session_parent", hasConversation: false });
  });

  it("does not follow wire or main-agent directory symlinks", async () => {
    const outside = writeJsonl(join(root, "outside", "wire.jsonl"), [
      { type: "turn.prompt", input: "外部" },
    ]);
    const fileLink = kimi("session_wire_link");
    rmSync(fileLink);
    symlinkSync(outside, fileLink);
    const directoryLink = dirname(kimi("session_directory_link"));
    rmSync(directoryLink, { recursive: true });
    symlinkSync(dirname(outside), directoryLink, "junction");
    expect(
      (await scanKimiHistory(join(root, "kimi"))).every((entry) => !entry.hasConversation),
    ).toBe(true);
  });
});
