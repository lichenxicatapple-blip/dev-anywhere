import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionState } from "@dev-anywhere/shared";
import { createControlMessageHandlers } from "#src/serve/handlers/control-messages.js";
import { createSessionManagerFake } from "./test-fakes.js";

const createMockSessionManager = createSessionManagerFake;

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

describe("control-messages: dir_create", () => {
  let sent: string[];

  beforeEach(() => {
    sent = [];
  });

  it("creates directory at valid absolute path", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-mkdir-"));
    const newDir = join(tmpDir, "my-project");

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirCreateRequest({ path: newDir });

    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("dir_create_response");
    expect(response.success).toBe(true);
    expect(response.path).toBe(newDir);

    // 验证目录确实存在
    const { statSync } = await import("node:fs");
    expect(statSync(newDir).isDirectory()).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates nested directories recursively", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-mkdir-"));
    const deepDir = join(tmpDir, "a", "b", "c");

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirCreateRequest({ path: deepDir });

    const response = JSON.parse(sent[0]);
    expect(response.success).toBe(true);

    const { statSync } = await import("node:fs");
    expect(statSync(deepDir).isDirectory()).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects relative path", async () => {
    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirCreateRequest({ path: "relative/path" });

    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("dir_create_response");
    expect(response.success).toBe(false);
    expect(response.error).toContain("Invalid path");
  });

  it("succeeds silently if directory already exists", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-mkdir-"));

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    await handlers.handleDirCreateRequest({ path: tmpDir });

    const response = JSON.parse(sent[0]);
    // recursive: true 使 mkdir 不报错如果已存在
    expect(response.success).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error for permission-denied path", async () => {
    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());
    // /proc 在 macOS 不存在，/System 需要 root 权限
    await handlers.handleDirCreateRequest({ path: "/System/forbidden-test-dir" });

    const response = JSON.parse(sent[0]);
    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
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
  it("sends file_tree_push with grouped 2-level tree", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-tree-"));
    await mkdir(join(tmpDir, "src"));
    await writeFile(join(tmpDir, "src", "index.ts"), "export {}");
    await writeFile(join(tmpDir, "package.json"), "{}");

    const sent: string[] = [];

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());

    await handlers.pushFileTree("sess-1", tmpDir);

    const response = JSON.parse(sent[0]);
    expect(response.type).toBe("file_tree_push");
    const groups = response.groups as Array<{
      path: string;
      entries: Array<{ name: string; isDir: boolean }>;
    }>;
    expect(groups[0].path).toBe(tmpDir);
    const rootNames = groups[0].entries.map((e) => e.name);
    expect(rootNames).toEqual(expect.arrayContaining(["src", "package.json"]));
    expect(rootNames).not.toContain("src/index.ts");

    const srcGroup = groups.find((g) => g.path === join(tmpDir, "src"));
    expect(srcGroup).toBeDefined();
    expect(srcGroup!.entries.map((e) => e.name)).toContain("index.ts");

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
    const rootNames = (response.groups[0].entries as Array<{ name: string }>).map((e) => e.name);
    expect(rootNames).not.toContain("node_modules");
    expect(rootNames).not.toContain(".git");
    expect(rootNames).toContain("visible.ts");
    // node_modules / .git 被跳过, 不应产生子目录分组
    const groupPaths = (response.groups as Array<{ path: string }>).map((g) => g.path);
    expect(groupPaths).not.toContain(join(tmpDir, "node_modules"));
    expect(groupPaths).not.toContain(join(tmpDir, ".git"));

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("control-messages: cleanup", () => {
  it("clears refresh timer on cleanup without error", async () => {
    const sent: string[] = [];

    const handlers = createControlMessageHandlers((d) => sent.push(d), createMockSessionManager());

    await handlers.pushCommandList("sess-1", "/tmp");

    // cleanup 应正常完成，不抛异常
    handlers.cleanup("sess-1");
  });
});

describe("control-messages: reinitializeOnReconnect", () => {
  it("re-pushes command list and file tree for active sessions", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ctrl-reinit-"));
    await writeFile(join(tmpDir, "app.ts"), "");

    const sent: string[] = [];

    const sessionManager = createMockSessionManager([
      { id: "active-1", state: SessionState.WORKING },
      { id: "terminated-1", state: SessionState.TERMINATED },
    ]);

    const handlers = createControlMessageHandlers((d) => sent.push(d), sessionManager);

    // 先推送一次建立 fileTreeWorkDir
    await handlers.pushFileTree("active-1", tmpDir);
    sent.length = 0;

    await handlers.reinitializeOnReconnect();

    // 应为 active session 推送 session_sync + command_list_push + file_tree_push
    const types = sent.map((s) => JSON.parse(s).type);
    expect(types).toContain("session_sync");
    expect(types).toContain("command_list_push");
    expect(types).toContain("file_tree_push");
    // terminated session 不应有推送（session_sync 也只包含 active session）
    expect(sent.length).toBe(3);

    // cleanup 定时器
    handlers.cleanup("active-1");
    await rm(tmpDir, { recursive: true, force: true });
  });
});
