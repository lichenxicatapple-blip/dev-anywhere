import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TerminalTracker } from "#src/terminal-tracker.js";
import type { SessionManager } from "#src/session-manager.js";
import { createControlMessageHandlers } from "#src/handlers/control-messages.js";

function createMockSessionManager(sessions: Array<{ id: string; state: string }> = []): SessionManager {
  return {
    listSessions: () => sessions.map((s) => ({
      id: s.id,
      mode: "pty" as const,
      state: s.state,
      createdAt: new Date().toISOString(),
    })),
  } as unknown as SessionManager;
}

function createMockTracker(overrides: Partial<TerminalTracker> = {}): TerminalTracker {
  return {
    extractLines: vi.fn().mockReturnValue({ startLineId: 0, lines: [[{ text: "line content" }]] }),
    getOldestLineId: vi.fn().mockReturnValue(0),
    getNewestLineId: vi.fn().mockReturnValue(10),
    ...overrides,
  } as unknown as TerminalTracker;
}

describe("control-messages: path traversal defense", () => {
  let sent: string[];

  beforeEach(() => {
    sent = [];
  });

  it("rejects relative path", async () => {
    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirListRequest({ path: "relative/path" });

    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("dir_list_response");
    expect(response.error).toContain("Invalid path");
    expect(response.entries).toEqual([]);
  });

  it("rejects relative path with .. traversal", async () => {
    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirListRequest({ path: "../../../etc/passwd" });

    const response = JSON.parse(sent[0]);
    expect(response.error).toContain("Invalid path");
  });

  it("normalizes absolute path with .. but still allows it (resolved to valid path)", async () => {
    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    // normalize resolves this to /etc/passwd which is a valid absolute path
    await handlers.handleDirListRequest({ path: "/home/user/../../../etc" });

    const response = JSON.parse(sent[0]);
    // 不会被 isPathSafe 拒绝，但 readdir 可能因权限或不存在而失败
    expect(response.type).toBe("dir_list_response");
    expect(response.error).not.toContain("Invalid path");
  });

  it("accepts valid absolute path and returns entries", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-test-"));
    await writeFile(join(tmpDir, "file.txt"), "content");
    await mkdir(join(tmpDir, "subdir"));

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirListRequest({ path: tmpDir });

    const response = JSON.parse(sent[0]);
    expect(response.error).toBeUndefined();
    expect(response.entries.length).toBe(2);
    // 目录排在前面
    expect(response.entries[0].isDir).toBe(true);
    expect(response.entries[0].name).toBe("subdir");
    expect(response.entries[1].isDir).toBe(false);
    expect(response.entries[1].name).toBe("file.txt");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error for nonexistent path", async () => {
    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirListRequest({ path: "/nonexistent/path/xyz" });

    const response = JSON.parse(sent[0]);
    expect(response.entries).toEqual([]);
    expect(response.error).toBeDefined();
  });

  it("hides dotfiles in listing", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-test-"));
    await writeFile(join(tmpDir, ".hidden"), "secret");
    await writeFile(join(tmpDir, "visible.txt"), "content");

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirListRequest({ path: tmpDir });

    const response = JSON.parse(sent[0]);
    expect(response.entries.length).toBe(1);
    expect(response.entries[0].name).toBe("visible.txt");

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("control-messages: terminal lines request", () => {
  it("forwards to tracker and returns response", () => {
    const sent: string[] = [];

    const tracker = createMockTracker({
      extractLines: vi.fn().mockReturnValue({ startLineId: 5, lines: [[{ text: "hello" }], [{ text: "world" }]] }),
      getOldestLineId: vi.fn().mockReturnValue(0),
      getNewestLineId: vi.fn().mockReturnValue(50),
    });

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    handlers.registerTracker("sess-1", tracker);
    handlers.handleTerminalLinesRequest({ sessionId: "sess-1", fromLineId: 5, count: 10 });

    expect(tracker.extractLines).toHaveBeenCalledWith(5, 10);
    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("terminal_lines_response");
    expect(response.sessionId).toBe("sess-1");
    expect(response.fromLineId).toBe(5);
    expect(response.oldestLineId).toBe(0);
    expect(response.newestLineId).toBe(50);
    expect(response.lines).toHaveLength(2);
  });

  it("returns error when no tracker registered for session", () => {
    const sent: string[] = [];

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());

    handlers.handleTerminalLinesRequest({ sessionId: "unknown", fromLineId: 0, count: 10 });

    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("control-messages: command list push", () => {
  it("sends command_list_push with static commands", async () => {
    const sent: string[] = [];

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());

    await handlers.pushCommandList("sess-1", "/tmp");

    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("command_list_push");
    expect(Array.isArray(response.commands)).toBe(true);
    expect(response.commands.length).toBeGreaterThan(0);
    expect(response.commands[0]).toHaveProperty("name");
    expect(response.commands[0]).toHaveProperty("description");
    expect(response.commands[0]).toHaveProperty("source");
  });
});

describe("control-messages: file tree push", () => {
  it("sends file_tree_push with 2-level tree", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-tree-"));
    await mkdir(join(tmpDir, "src"));
    await writeFile(join(tmpDir, "src", "index.ts"), "export {}");
    await writeFile(join(tmpDir, "package.json"), "{}");

    const sent: string[] = [];

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());

    await handlers.pushFileTree("sess-1", tmpDir);

    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("file_tree_push");
    expect(response.path).toBe(tmpDir);
    // 应包含 src/ 目录和 package.json 以及 src/index.ts
    const names = response.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("package.json");
    expect(names).toContain("src/index.ts");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("skips node_modules and dotfiles", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-tree-"));
    await mkdir(join(tmpDir, "node_modules"));
    await writeFile(join(tmpDir, "node_modules", "pkg.js"), "");
    await mkdir(join(tmpDir, ".git"));
    await writeFile(join(tmpDir, "visible.ts"), "");

    const sent: string[] = [];

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());

    await handlers.pushFileTree("sess-1", tmpDir);

    const response = JSON.parse(sent[0]);
    const names = response.entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).toContain("visible.ts");

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("control-messages: cleanup", () => {
  it("removes tracker and clears refresh timer on cleanup", async () => {
    const sent: string[] = [];

    const tracker = createMockTracker();
    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());

    handlers.registerTracker("sess-1", tracker);
    await handlers.pushCommandList("sess-1", "/tmp");

    // cleanup 后 tracker 不再可用
    handlers.cleanup("sess-1");

    sent.length = 0;
    handlers.handleTerminalLinesRequest({ sessionId: "sess-1", fromLineId: 0, count: 10 });

    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("control-messages: reinitializeOnReconnect", () => {
  it("re-pushes command list and file tree for active sessions", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-reinit-"));
    await writeFile(join(tmpDir, "app.ts"), "");

    const sent: string[] = [];

    const sessionManager = createMockSessionManager([
      { id: "active-1", state: "running" },
      { id: "terminated-1", state: "terminated" },
    ]);

    const handlers = createControlMessageHandlers((d) => sent.push(d), sessionManager);

    // 先推送一次建立 fileTreeWorkDir
    await handlers.pushFileTree("active-1", tmpDir);
    sent.length = 0;

    await handlers.reinitializeOnReconnect();

    // 应为 active session 重新推送 command_list_push 和 file_tree_push
    const types = sent.map((s) => JSON.parse(s).type);
    expect(types).toContain("command_list_push");
    expect(types).toContain("file_tree_push");
    // terminated session 不应有推送
    expect(sent.length).toBe(2);

    // cleanup 定时器
    handlers.cleanup("active-1");
    await rm(tmpDir, { recursive: true, force: true });
  });
});
