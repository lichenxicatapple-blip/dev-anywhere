import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock, tryAcquireFileLock, type FileLock } from "#src/common/file-lock.js";

interface Fixture {
  child: ChildProcess;
  messages: unknown[];
  closed: Promise<void>;
  stderr: string;
  error?: Error;
}

const fixtures = new Set<Fixture>();
const roots = new Set<string>();
const localLocks = new Set<FileLock>();
const fixturePath = fileURLToPath(new URL("./fixtures/file-lock-child.ts", import.meta.url));

function makePath(): string {
  const root = mkdtempSync(join(tmpdir(), "dev-anywhere-file-lock-"));
  roots.add(root);
  return join(root, "run", "service.lock");
}

function trackLock(lock: FileLock | null): FileLock | null {
  if (lock) localLocks.add(lock);
  return lock;
}

function spawnFixture(path: string): Fixture {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, path], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  const fixture: Fixture = {
    child,
    messages: [],
    closed: new Promise<void>((resolve) => child.once("close", () => resolve())),
    stderr: "",
  };
  child.on("message", (message) => fixture.messages.push(message));
  child.on("error", (error) => (fixture.error = error));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    fixture.stderr = `${fixture.stderr}${chunk}`.slice(-4096);
  });
  fixtures.add(fixture);
  return fixture;
}

async function receive(fixture: Fixture): Promise<unknown> {
  const deadline = performance.now() + 10_000;
  while (fixture.messages.length === 0) {
    if (fixture.error) throw fixture.error;
    if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) {
      throw new Error(`Lock fixture exited before replying: ${fixture.stderr}`);
    }
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for lock fixture: ${fixture.stderr}`);
    }
    await sleep(5);
  }
  return fixture.messages.shift();
}

async function holdingFixture(path: string): Promise<Fixture> {
  const fixture = spawnFixture(path);
  expect(await receive(fixture)).toBe("ready");
  fixture.child.send("acquire");
  expect(await receive(fixture)).toBe("acquired");
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures) fixture.child.kill("SIGKILL");
  await Promise.all([...fixtures].map((fixture) => fixture.closed));
  fixtures.clear();
  for (const lock of localLocks) lock.release();
  localLocks.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("native file locks across processes", () => {
  it("allows only one simultaneous contender to acquire the lock", async () => {
    const path = makePath();
    const contenders = Array.from({ length: 8 }, () => spawnFixture(path));
    expect(await Promise.all(contenders.map(receive))).toEqual(Array(8).fill("ready"));
    for (const contender of contenders) contender.child.send("acquire");
    const results = await Promise.all(contenders.map(receive));
    expect(results.filter((result) => result === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result === "unavailable")).toHaveLength(7);
    expect(trackLock(tryAcquireFileLock(path))).toBeNull();
  });

  it("releases a SIGKILLed owner's lock without deleting its file", async () => {
    const path = makePath();
    const owner = await holdingFixture(path);
    const inode = statSync(path).ino;
    owner.child.kill("SIGKILL");
    await owner.closed;
    expect(trackLock(tryAcquireFileLock(path))).not.toBeNull();
    expect(statSync(path).ino).toBe(inode);
  });

  it("does not steal a blocked owner's lock when a waiter times out", async () => {
    const path = makePath();
    const owner = await holdingFixture(path);
    owner.child.send("block");
    await expect.poll(() => existsSync(`${path}.blocked`)).toBe(true);
    owner.child.send("ping");
    try {
      await expect(acquireFileLock(path, { timeoutMs: 100, pollMs: 5 })).rejects.toThrow(
        "Timed out waiting for file lock",
      );
      expect(owner.child.exitCode).toBeNull();
      expect(trackLock(tryAcquireFileLock(path))).toBeNull();
      // Ping is queued on the IPC channel: the owner is really unable to service its event loop.
      expect(owner.messages).toEqual([]);
    } finally {
      writeFileSync(`${path}.resume`, "resume");
    }
    expect(await receive(owner)).toBe("unblocked");
    expect(await receive(owner)).toBe("pong");
    owner.child.send("release");
    expect(await receive(owner)).toBe("released");
    expect(trackLock(tryAcquireFileLock(path))).not.toBeNull();
  });

  it("lets a waiter acquire the lock after the holder releases it", async () => {
    const path = makePath();
    const owner = await holdingFixture(path);
    const waiting = acquireFileLock(path, { timeoutMs: 2_000, pollMs: 5 });
    owner.child.send("release");
    expect(await receive(owner)).toBe("released");
    expect(trackLock(await waiting)).not.toBeNull();
  });

  it("releases the lock on normal process exit without explicit cleanup", async () => {
    const path = makePath();
    const owner = await holdingFixture(path);
    owner.child.send("exit");
    await owner.closed;
    expect(owner.child.exitCode).toBe(0);
    expect(trackLock(tryAcquireFileLock(path))).not.toBeNull();
  });

  it("keeps separate lock paths independent", async () => {
    const first = makePath();
    const second = makePath();
    await holdingFixture(first);
    expect(trackLock(tryAcquireFileLock(first))).toBeNull();
    expect(trackLock(tryAcquireFileLock(second))).not.toBeNull();
  });

  it("keeps the same inode and makes release idempotent", () => {
    const path = makePath();
    const first = trackLock(tryAcquireFileLock(path));
    expect(first).not.toBeNull();
    const inode = statSync(path).ino;
    first?.release();
    expect(existsSync(path)).toBe(true);
    const second = trackLock(tryAcquireFileLock(path));
    expect(second).not.toBeNull();
    first?.release();
    expect(trackLock(tryAcquireFileLock(path))).toBeNull();
    expect(statSync(path).ino).toBe(inode);
  });

  it("acquires a free lock with a zero timeout and bounds failed acquisition", async () => {
    const path = makePath();
    expect(trackLock(await acquireFileLock(path, { timeoutMs: 0 }))).not.toBeNull();
    await expect(acquireFileLock(path, { timeoutMs: 0 })).rejects.toThrow(
      "Timed out waiting for file lock",
    );
  });

  it.each([
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { pollMs: 0 },
    { pollMs: Number.POSITIVE_INFINITY },
  ])("rejects invalid wait options %j", async (options) => {
    const path = makePath();
    await expect(acquireFileLock(path, options)).rejects.toBeInstanceOf(RangeError);
    expect(existsSync(path)).toBe(false);
  });
});
