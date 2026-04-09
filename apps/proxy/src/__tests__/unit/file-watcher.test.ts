import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FileWatcher } from "#src/file-watcher.js";
import { listDirectory, isBlacklistedPath } from "#src/dir-lister.js";

const TEST_DIR = join(process.cwd(), ".test-file-watcher");

describe("FileWatcher", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("emits update event when a file is created in watched directory", async () => {
    const updates: Array<{ dirPath: string }> = [];
    const watcher = new FileWatcher(TEST_DIR, (dirPath, _entries) => {
      updates.push({ dirPath });
    }, 100);
    watcher.getInitialTree(1);
    watcher.start();

    // 在监控目录中创建文件触发更新事件
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(TEST_DIR, "new-file.txt"), "hello");

    // 等待 throttle 触发
    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();

    expect(updates.length).toBeGreaterThan(0);
  });

  it("does not emit for changes in blacklisted directories", async () => {
    const nodeModules = join(TEST_DIR, "node_modules");
    mkdirSync(nodeModules, { recursive: true });

    const updates: string[] = [];
    const watcher = new FileWatcher(TEST_DIR, (dirPath) => {
      updates.push(dirPath);
    }, 100);
    watcher.start();

    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(nodeModules, "some-pkg.js"), "module.exports = {}");

    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();

    // node_modules 下的变化不应触发回调
    const blacklistedUpdates = updates.filter((p) => p.includes("node_modules"));
    expect(blacklistedUpdates).toHaveLength(0);
  });

  it("throttles events to configured interval per directory", async () => {
    const updates: string[] = [];
    const watcher = new FileWatcher(TEST_DIR, (dirPath) => {
      updates.push(dirPath);
    }, 200);
    watcher.start();

    await new Promise((r) => setTimeout(r, 50));

    // 快速连续写入多个文件到同一目录
    writeFileSync(join(TEST_DIR, "file1.txt"), "a");
    writeFileSync(join(TEST_DIR, "file2.txt"), "b");
    writeFileSync(join(TEST_DIR, "file3.txt"), "c");

    // 第一轮 throttle 到期
    await new Promise((r) => setTimeout(r, 350));
    watcher.stop();

    // 同一目录的多次变化应被合并，只触发一次或极少次
    const rootUpdates = updates.filter((p) => p === TEST_DIR);
    expect(rootUpdates.length).toBeLessThanOrEqual(2);
  });

  it("getInitialTree returns first two levels of directory structure", () => {
    // 创建目录结构:
    // root/
    //   level1-dir/
    //     level2-dir/
    //       level3-file.txt  (不应出现在 depth=2 的结果中)
    //   level1-file.txt
    mkdirSync(join(TEST_DIR, "level1-dir", "level2-dir"), { recursive: true });
    writeFileSync(join(TEST_DIR, "level1-file.txt"), "");
    writeFileSync(join(TEST_DIR, "level1-dir", "level2-file.txt"), "");
    writeFileSync(join(TEST_DIR, "level1-dir", "level2-dir", "level3-file.txt"), "");

    const watcher = new FileWatcher(TEST_DIR, () => {}, 2000);
    const tree = watcher.getInitialTree(2);

    // depth=0 (root) 的 entries 应包含 level1-dir 和 level1-file.txt
    const rootEntries = tree.get(TEST_DIR);
    expect(rootEntries).toBeDefined();
    const rootNames = rootEntries!.map((e) => e.name);
    expect(rootNames).toContain("level1-dir");
    expect(rootNames).toContain("level1-file.txt");

    // depth=1 (level1-dir) 的 entries 应包含 level2-dir 和 level2-file.txt
    const l1Entries = tree.get(join(TEST_DIR, "level1-dir"));
    expect(l1Entries).toBeDefined();
    const l1Names = l1Entries!.map((e) => e.name);
    expect(l1Names).toContain("level2-dir");
    expect(l1Names).toContain("level2-file.txt");

    // depth=2 以下的目录不应作为 key 出现
    expect(tree.has(join(TEST_DIR, "level1-dir", "level2-dir"))).toBe(false);
  });

  it("does not push changes for directories outside watchedDirs scope", async () => {
    // 创建深层目录结构
    const deepDir = join(TEST_DIR, "a", "b", "c");
    mkdirSync(deepDir, { recursive: true });

    const updates: string[] = [];
    const watcher = new FileWatcher(TEST_DIR, (dirPath) => {
      updates.push(dirPath);
    }, 100);

    // getInitialTree(1) 只把第 0 层加入 watchedDirs
    watcher.getInitialTree(1);
    watcher.start();

    await new Promise((r) => setTimeout(r, 50));
    // 在深层目录写入文件，该目录不在 watchedDirs 中
    writeFileSync(join(deepDir, "deep-file.txt"), "deep");

    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();

    // 深层目录的变化不应触发回调
    const deepUpdates = updates.filter((p) => p.includes(join("a", "b", "c")));
    expect(deepUpdates).toHaveLength(0);
  });

  it("expandWatch() adds directory to push scope so changes are reported", async () => {
    const subDir = join(TEST_DIR, "expanded");
    mkdirSync(subDir, { recursive: true });

    const updates: string[] = [];
    const watcher = new FileWatcher(TEST_DIR, (dirPath) => {
      updates.push(dirPath);
    }, 100);

    // 初始不包含 expanded 目录
    watcher.getInitialTree(1);
    watcher.start();

    // 手动扩展 watch 范围
    watcher.expandWatch(subDir);

    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(subDir, "new.txt"), "hello");

    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();

    // expandWatch 后该目录的变化应触发回调
    const expandedUpdates = updates.filter((p) => p.includes("expanded"));
    expect(expandedUpdates.length).toBeGreaterThan(0);
  });

  it("getInitialTree registers traversed directories into watchedDirs", async () => {
    mkdirSync(join(TEST_DIR, "level1"), { recursive: true });

    const updates: string[] = [];
    const watcher = new FileWatcher(TEST_DIR, (dirPath) => {
      updates.push(dirPath);
    }, 100);

    // depth=2 应把 root 和 level1 都加入 watchedDirs
    watcher.getInitialTree(2);
    watcher.start();

    await new Promise((r) => setTimeout(r, 50));
    // root 目录内的变化应触发
    writeFileSync(join(TEST_DIR, "root-file.txt"), "root");

    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();

    expect(updates.length).toBeGreaterThan(0);
  });

  it("stop() stops watching and clears timers", async () => {
    const updates: string[] = [];
    const watcher = new FileWatcher(TEST_DIR, (dirPath) => {
      updates.push(dirPath);
    }, 500);
    watcher.start();
    watcher.stop();

    // stop 之后写入文件不应触发回调
    writeFileSync(join(TEST_DIR, "after-stop.txt"), "should not trigger");
    await new Promise((r) => setTimeout(r, 700));

    expect(updates).toHaveLength(0);
  });
});

describe("listDirectory", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns array of { name, isDir } entries for a valid path", () => {
    mkdirSync(join(TEST_DIR, "subdir"));
    writeFileSync(join(TEST_DIR, "file.txt"), "content");

    const entries = listDirectory(TEST_DIR);
    expect(entries.length).toBe(2);

    const dir = entries.find((e) => e.name === "subdir");
    expect(dir).toBeDefined();
    expect(dir!.isDir).toBe(true);

    const file = entries.find((e) => e.name === "file.txt");
    expect(file).toBeDefined();
    expect(file!.isDir).toBe(false);
  });

  it("returns empty array for non-existent path", () => {
    const entries = listDirectory(join(TEST_DIR, "non-existent"));
    expect(entries).toEqual([]);
  });

  it("sorts directories first, then files, alphabetically", () => {
    mkdirSync(join(TEST_DIR, "beta-dir"));
    mkdirSync(join(TEST_DIR, "alpha-dir"));
    writeFileSync(join(TEST_DIR, "zebra.txt"), "");
    writeFileSync(join(TEST_DIR, "apple.txt"), "");

    const entries = listDirectory(TEST_DIR);
    const names = entries.map((e) => e.name);

    // 目录在前，按字母序；文件在后，按字母序
    expect(names).toEqual(["alpha-dir", "beta-dir", "apple.txt", "zebra.txt"]);
  });

  it("filters out blacklisted names from results", () => {
    mkdirSync(join(TEST_DIR, "node_modules"));
    mkdirSync(join(TEST_DIR, ".git"));
    mkdirSync(join(TEST_DIR, "src"));
    writeFileSync(join(TEST_DIR, "index.ts"), "");

    const entries = listDirectory(TEST_DIR);
    const names = entries.map((e) => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).toContain("src");
    expect(names).toContain("index.ts");
  });
});

describe("isBlacklistedPath", () => {
  it("returns true for paths containing blacklisted segments", () => {
    expect(isBlacklistedPath("/project/node_modules/pkg/index.js")).toBe(true);
    expect(isBlacklistedPath("/project/.git/config")).toBe(true);
    expect(isBlacklistedPath("/project/dist/bundle.js")).toBe(true);
  });

  it("returns false for normal paths", () => {
    expect(isBlacklistedPath("/project/src/index.ts")).toBe(false);
    expect(isBlacklistedPath("/project/lib/utils.js")).toBe(false);
  });
});
