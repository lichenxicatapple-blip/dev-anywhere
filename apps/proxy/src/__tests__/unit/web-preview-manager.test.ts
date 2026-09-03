import { EventEmitter } from "node:events";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import type { CloudflaredQuickTunnel } from "#src/common/cloudflared-quick-tunnel.js";
import type { CpolarQuickTunnel } from "#src/common/cpolar-quick-tunnel.js";
import type { CloudflaredLocator } from "#src/serve/preview/cloudflared-locator.js";
import type { CpolarLocator } from "#src/serve/preview/cpolar-locator.js";
import { buildPreviewPublicUrl, PreviewManager } from "#src/serve/preview/preview-manager.js";
import type { PreviewStore } from "#src/serve/preview/preview-store.js";
import type { PersistedPreviewDefinition, PreviewSummary } from "#src/serve/preview/types.js";

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  return child;
}

function createTunnel(): CloudflaredQuickTunnel {
  return {
    child: fakeChild(),
    publicUrl: Promise.resolve("https://quiet-river-42.trycloudflare.com"),
    connectionReady: Promise.resolve(),
    publicReady: Promise.resolve("https://quiet-river-42.trycloudflare.com"),
    getOutput: () => "",
    stop: vi.fn(async () => undefined),
  };
}

function createCpolarTunnel(): CpolarQuickTunnel {
  return {
    child: fakeChild(),
    publicUrl: Promise.resolve("https://preview-42.r5.cpolar.top"),
    publicReady: Promise.resolve("https://preview-42.r5.cpolar.top"),
    getOutput: () => "",
    stop: vi.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryStore {
  definitions: PersistedPreviewDefinition[];
  failSave = false;
  readonly save = vi.fn((definitions: readonly PersistedPreviewDefinition[]) => {
    if (this.failSave) throw new Error("disk unavailable");
    this.definitions = definitions.map((definition) => ({
      ...definition,
      source: { ...definition.source },
    }));
  });

  constructor(definitions: PersistedPreviewDefinition[] = []) {
    this.definitions = definitions;
  }

  load(): PersistedPreviewDefinition[] {
    return this.definitions.map((definition) => ({
      ...definition,
      source: { ...definition.source },
    }));
  }
}

function locatedCloudflared() {
  return {
    capability: {
      available: true as const,
      command: "/usr/local/bin/cloudflared",
      version: "cloudflared version test",
    },
    command: "/usr/local/bin/cloudflared",
    env: { PATH: "/usr/local/bin:/usr/bin" },
  };
}

function locatedCpolar() {
  return {
    capability: {
      available: true as const,
      command: "/opt/homebrew/bin/cpolar",
      version: "cpolar version test",
    },
    command: "/opt/homebrew/bin/cpolar",
    env: { PATH: "/opt/homebrew/bin:/usr/bin" },
  };
}

function managerOptions(
  store: MemoryStore,
  locator = { inspect: vi.fn(async () => locatedCloudflared()) },
) {
  return {
    persistPath: "/unused/previews.json",
    runtimeRoot: "/unused/run",
    store: store as unknown as PreviewStore,
    locator: locator as unknown as CloudflaredLocator,
    startGateway: vi.fn(async () => ({
      originUrl: "http://127.0.0.1:45678",
      deactivate: vi.fn(),
      close: vi.fn(async () => undefined),
    })),
    startTunnel: vi.fn(() => createTunnel()),
  };
}

const tempPaths: string[] = [];

async function staticFixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dev-anywhere-manager-"));
  tempPaths.push(path);
  await writeFile(join(path, "index.html"), "<!doctype html>");
  return realpath(path);
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PreviewManager protocol invariants", () => {
  it("keeps URL fragments only in the final public URL", () => {
    const summary: PreviewSummary = {
      previewId: "preview-1",
      name: "localhost:5173",
      source: { kind: "local", url: "http://localhost:5173/admin?tab=one#details" },
      state: "starting",
      tunnelProvider: "cloudflare",
      createdAt: 1,
      updatedAt: 1,
    };
    expect(buildPreviewPublicUrl("https://quiet-river-42.trycloudflare.com", summary)).toBe(
      "https://quiet-river-42.trycloudflare.com/admin?tab=one#details",
    );
  });

  it("preserves create operation identity across Proxy restart", async () => {
    const root = await staticFixture();
    const store = new MemoryStore();
    const options = managerOptions(store);
    const manager = new PreviewManager(options);

    const first = await manager.create(
      "operation-1",
      { kind: "static", path: root, entryPath: "index.html" },
      "cloudflare",
    );
    expect(manager.list().previews).toHaveLength(1);
    expect(first).not.toHaveProperty("operationId");
    expect(store.definitions[0]?.operationId).toBe("operation-1");

    const restartedLocator = { inspect: vi.fn(async () => locatedCloudflared()) };
    const restarted = new PreviewManager(managerOptions(store, restartedLocator));
    expect(restarted.list().previews[0]).toMatchObject({
      previewId: first.previewId,
      state: "disconnected",
    });
    const afterRestartRetry = await restarted.create(
      "operation-1",
      {
        kind: "static",
        path: root,
        entryPath: "index.html",
      },
      "cloudflare",
    );
    expect(afterRestartRetry.previewId).toBe(first.previewId);
    expect(restartedLocator.inspect).not.toHaveBeenCalled();
    expect(() =>
      restarted.create(
        "operation-1",
        { kind: "static", path: root, entryPath: "index.html" },
        "cloudflare",
        "Different preview",
      ),
    ).toThrow(expect.objectContaining({ errorCode: ControlErrorCode.OPERATION_CONFLICT }));
    await Promise.all([manager.shutdown(), restarted.shutdown()]);
  });

  it("uses optional custom names and persists rename without restarting the preview runtime", async () => {
    const root = await staticFixture();
    const store = new MemoryStore();
    let now = 100;
    const events: Array<{ type: string; revision: number }> = [];
    const options = {
      ...managerOptions(store),
      runtimeRoot: root,
      now: () => now,
      onEvent: (event: { type: string; revision: number }) => events.push(event),
    };
    const manager = new PreviewManager(options);

    const automatic = await manager.create(
      "automatic-name",
      { kind: "static", path: root, entryPath: "index.html" },
      "cloudflare",
      "  ",
    );
    const custom = await manager.create(
      "custom-name",
      { kind: "static", path: root, entryPath: "index.html" },
      "cloudflare",
      "  Landing page  ",
    );
    expect(automatic.name).not.toBe("");
    expect(custom.name).toBe("Landing page");

    await vi.waitFor(() => expect(options.startTunnel).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(manager.list().previews.every((preview) => preview.state === "ready")).toBe(true),
    );
    const startsBeforeRename = options.startGateway.mock.calls.length;
    const revisionBeforeRename = manager.list().revision;
    now = 200;

    const renamed = manager.rename(custom.previewId, "  Product demo  ");

    expect(renamed).toMatchObject({ name: "Product demo", updatedAt: 200, state: "ready" });
    expect(manager.list().revision).toBe(revisionBeforeRename + 1);
    expect(options.startGateway).toHaveBeenCalledTimes(startsBeforeRename);
    expect(store.definitions.find((item) => item.previewId === custom.previewId)).toMatchObject({
      name: "Product demo",
      updatedAt: 200,
    });
    expect(events.at(-1)).toMatchObject({ type: "state", revision: revisionBeforeRename + 1 });

    const restarted = new PreviewManager(managerOptions(store));
    expect(
      restarted.list().previews.find((preview) => preview.previewId === custom.previewId),
    ).toMatchObject({
      name: "Product demo",
      state: "disconnected",
    });
    await Promise.all([manager.shutdown(), restarted.shutdown()]);
  });

  it("rejects invalid rename and rolls back when the renamed definition cannot be saved", async () => {
    const root = await staticFixture();
    const store = new MemoryStore();
    const options = { ...managerOptions(store), runtimeRoot: root, now: () => 200 };
    const manager = new PreviewManager(options);
    const created = await manager.create(
      "rename-rollback",
      { kind: "static", path: root, entryPath: "index.html" },
      "cloudflare",
    );
    const revisionBeforeRename = manager.list().revision;

    expect(() => manager.rename(created.previewId, "   ")).toThrow("预览名称不能为空");
    expect(() => manager.rename(created.previewId, "bad\nname")).toThrow("不能包含控制字符");
    store.failSave = true;
    expect(() => manager.rename(created.previewId, "Unsaved name")).toThrow("无法保存预览名称");
    expect(manager.list()).toMatchObject({
      revision: revisionBeforeRename,
      previews: [{ previewId: created.previewId, name: created.name }],
    });
    expect(store.definitions[0]?.name).toBe(created.name);

    store.failSave = false;
    await manager.shutdown();
  });

  it("launches the selected cpolar provider and persists it for reconnect", async () => {
    const root = await staticFixture();
    const store = new MemoryStore();
    const options = {
      ...managerOptions(store),
      runtimeRoot: root,
      cpolarLocator: {
        inspect: vi.fn(async () => locatedCpolar()),
      } as unknown as CpolarLocator,
      startCpolarTunnel: vi.fn(() => createCpolarTunnel()),
    };
    const manager = new PreviewManager(options);

    const created = await manager.create(
      "cpolar-operation",
      { kind: "static", path: root, entryPath: "index.html" },
      "cpolar",
    );
    expect(created.tunnelProvider).toBe("cpolar");
    await vi.waitFor(() => expect(options.startCpolarTunnel).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(manager.list().previews[0]).toMatchObject({
        state: "ready",
        tunnelProvider: "cpolar",
        publicUrl: "https://preview-42.r5.cpolar.top/index.html",
      }),
    );
    expect(options.startTunnel).not.toHaveBeenCalled();
    expect(options.startCpolarTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        cpolarBin: "/opt/homebrew/bin/cpolar",
        originUrl: "http://127.0.0.1:45678",
        tunnelName: expect.stringMatching(/^dev_anywhere_.+_1$/),
      }),
    );
    const firstTunnelName = (
      options.startCpolarTunnel.mock.calls as unknown as Array<[{ tunnelName: string }]>
    )[0]![0].tunnelName;
    const firstRuntimeDir = (await readdir(root)).find((entry) =>
      entry.startsWith(`${created.previewId}-`),
    );
    expect(firstRuntimeDir).toBeDefined();
    expect(store.definitions[0]).toMatchObject({ tunnelProvider: "cpolar" });
    await manager.shutdown();

    const reconnectTunnel = vi.fn(() => createCpolarTunnel());
    const restarted = new PreviewManager({
      ...managerOptions(store),
      runtimeRoot: root,
      cpolarLocator: {
        inspect: vi.fn(async () => locatedCpolar()),
      } as unknown as CpolarLocator,
      startCpolarTunnel: reconnectTunnel,
    });
    expect(restarted.list().previews[0]).toMatchObject({
      state: "disconnected",
      tunnelProvider: "cpolar",
    });
    await restarted.reconnect(created.previewId);
    await vi.waitFor(() => expect(reconnectTunnel).toHaveBeenCalledOnce());
    const secondTunnelName = (
      reconnectTunnel.mock.calls as unknown as Array<[{ tunnelName: string }]>
    )[0]![0].tunnelName;
    const secondRuntimeDir = (await readdir(root)).find((entry) =>
      entry.startsWith(`${created.previewId}-`),
    );
    expect(secondTunnelName).not.toBe(firstTunnelName);
    expect(secondRuntimeDir).toBeDefined();
    expect(secondRuntimeDir).not.toBe(firstRuntimeDir);
    await restarted.shutdown();
  });

  it("becomes ready only after cloudflared verifies public reachability", async () => {
    const root = await staticFixture();
    const publicReady = deferred<string>();
    const tunnel: CloudflaredQuickTunnel = {
      child: fakeChild(),
      publicUrl: Promise.resolve("https://quiet-river-42.trycloudflare.com"),
      connectionReady: Promise.resolve(),
      publicReady: publicReady.promise,
      getOutput: () => "",
      stop: vi.fn(async () => undefined),
    };
    const options = managerOptions(new MemoryStore());
    options.runtimeRoot = root;
    options.startTunnel = vi.fn(() => tunnel);
    const manager = new PreviewManager(options);

    const created = await manager.create(
      "connector-readiness",
      { kind: "static", path: root, entryPath: "index.html" },
      "cloudflare",
    );
    await vi.waitFor(() => expect(options.startTunnel).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const waitingForReachability = manager.list().previews[0];
    expect(waitingForReachability).toMatchObject({
      previewId: created.previewId,
      state: "starting",
    });
    expect(waitingForReachability).not.toHaveProperty("publicUrl");

    publicReady.resolve("https://quiet-river-42.trycloudflare.com");
    await vi.waitFor(() =>
      expect(manager.list().previews[0]).toMatchObject({
        previewId: created.previewId,
        state: "ready",
        publicUrl: "https://quiet-river-42.trycloudflare.com/index.html",
      }),
    );
    await manager.shutdown();
  });

  it("reserves capacity before async validation so concurrent creates cannot exceed eight", async () => {
    const root = await staticFixture();
    let resolveLocate!: (value: ReturnType<typeof locatedCloudflared>) => void;
    const pendingLocate = new Promise<ReturnType<typeof locatedCloudflared>>((resolve) => {
      resolveLocate = resolve;
    });
    const locator = { inspect: vi.fn(() => pendingLocate) };
    const manager = new PreviewManager(managerOptions(new MemoryStore(), locator));
    const accepted = Array.from({ length: 8 }, (_, index) =>
      manager.create(
        `operation-${index}`,
        { kind: "static" as const, path: root, entryPath: "index.html" },
        "cloudflare",
      ),
    );

    expect(() =>
      manager.create(
        "operation-9",
        { kind: "static", path: root, entryPath: "index.html" },
        "cloudflare",
      ),
    ).toThrow(/最多同时开启 8 个/);
    resolveLocate(locatedCloudflared());
    await Promise.all(accepted);
    expect(manager.list().previews).toHaveLength(8);
    await manager.shutdown();
  });

  it("shares same-preview reconnect work and reserves global reconnect capacity", async () => {
    const definitions: PersistedPreviewDefinition[] = Array.from({ length: 9 }, (_, index) => ({
      previewId: `reconnect-${index}`,
      name: `preview-${index}`,
      source: { kind: "static", rootPath: "/tmp", entryPath: "index.html" },
      tunnelProvider: "cloudflare",
      createdAt: index,
      updatedAt: index,
      operationId: `reconnect-operation-${index}`,
      operationFingerprint: "a".repeat(64),
    }));
    let resolveLocate!: (value: ReturnType<typeof locatedCloudflared>) => void;
    const pendingLocate = new Promise<ReturnType<typeof locatedCloudflared>>((resolve) => {
      resolveLocate = resolve;
    });
    const locator = { inspect: vi.fn(() => pendingLocate) };
    const options = managerOptions(new MemoryStore(definitions), locator);
    const manager = new PreviewManager(options);

    const first = manager.reconnect("reconnect-0");
    const samePreviewRetry = manager.reconnect("reconnect-0");
    const otherPreviews = Array.from({ length: 7 }, (_, index) =>
      manager.reconnect(`reconnect-${index + 1}`),
    );
    await expect(manager.reconnect("reconnect-8")).rejects.toThrow(/最多同时开启 8 个/);
    expect(locator.inspect).toHaveBeenCalledTimes(8);

    resolveLocate(locatedCloudflared());
    await Promise.all([first, samePreviewRetry, ...otherPreviews]);
    expect(options.startGateway).toHaveBeenCalledTimes(8);
    await manager.shutdown();
  });

  it("does not start a pending reconnect after close or shutdown wins the race", async () => {
    const makePendingManager = () => {
      let resolveLocate!: (value: ReturnType<typeof locatedCloudflared>) => void;
      const locator = {
        inspect: vi.fn(
          () =>
            new Promise<ReturnType<typeof locatedCloudflared>>((resolve) => {
              resolveLocate = resolve;
            }),
        ),
      };
      const definition: PersistedPreviewDefinition = {
        previewId: "pending-preview",
        name: "pending",
        source: { kind: "static", rootPath: "/tmp", entryPath: "index.html" },
        tunnelProvider: "cloudflare",
        createdAt: 1,
        updatedAt: 1,
        operationId: "pending-operation",
        operationFingerprint: "b".repeat(64),
      };
      const options = managerOptions(new MemoryStore([definition]), locator);
      return {
        manager: new PreviewManager(options),
        options,
        resolveLocate: () => resolveLocate(locatedCloudflared()),
      };
    };

    const closing = makePendingManager();
    const closeRace = closing.manager.reconnect("pending-preview");
    await closing.manager.close("pending-preview");
    closing.resolveLocate();
    await expect(closeRace).rejects.toThrow(/正在关闭/);
    expect(closing.options.startGateway).not.toHaveBeenCalled();
    expect(closing.manager.list().previews).toEqual([]);

    const stopping = makePendingManager();
    const shutdownRace = stopping.manager.reconnect("pending-preview");
    await stopping.manager.shutdown();
    stopping.resolveLocate();
    await expect(shutdownRace).rejects.toThrow(/正在停止/);
    expect(stopping.options.startGateway).not.toHaveBeenCalled();
  });

  it("does not persist or start a create whose validation loses the shutdown race", async () => {
    const root = await staticFixture();
    let resolveLocate!: (value: ReturnType<typeof locatedCloudflared>) => void;
    const locator = {
      inspect: vi.fn(
        () =>
          new Promise<ReturnType<typeof locatedCloudflared>>((resolve) => {
            resolveLocate = resolve;
          }),
      ),
    };
    const store = new MemoryStore();
    const options = managerOptions(store, locator);
    const manager = new PreviewManager(options);
    const create = manager.create(
      "pending-create",
      { kind: "static", path: root, entryPath: "index.html" },
      "cloudflare",
    );

    await manager.shutdown();
    resolveLocate(locatedCloudflared());
    await expect(create).rejects.toThrow(/正在停止/);
    expect(manager.list().previews).toEqual([]);
    expect(store.definitions).toEqual([]);
    expect(options.startGateway).not.toHaveBeenCalled();
    expect(options.startTunnel).not.toHaveBeenCalled();
  });

  it("caps all persisted definitions even when disconnected previews do not count as active", async () => {
    const definitions: PersistedPreviewDefinition[] = Array.from({ length: 100 }, (_, index) => ({
      previewId: `preview-${index}`,
      name: `preview-${index}`,
      source: { kind: "static", rootPath: "/tmp", entryPath: "index.html" },
      tunnelProvider: "cloudflare",
      createdAt: index,
      updatedAt: index,
      operationId: `old-operation-${index}`,
      operationFingerprint: "c".repeat(64),
    }));
    const locator = { inspect: vi.fn(async () => locatedCloudflared()) };
    const manager = new PreviewManager(managerOptions(new MemoryStore(definitions), locator));

    expect(() =>
      manager.create(
        "new-operation",
        { kind: "static", path: "/tmp", entryPath: "index.html" },
        "cloudflare",
      ),
    ).toThrow(/最多保留 100 个/);
    expect(locator.inspect).not.toHaveBeenCalled();
  });

  it("rolls back a new record when its durable definition cannot be saved", async () => {
    const root = await staticFixture();
    const store = new MemoryStore();
    store.failSave = true;
    const options = managerOptions(store);
    const manager = new PreviewManager(options);

    await expect(
      manager.create(
        "operation-fails",
        { kind: "static", path: root, entryPath: "index.html" },
        "cloudflare",
      ),
    ).rejects.toThrow("无法保存网页预览");
    expect(manager.list().previews).toEqual([]);
    expect(options.startGateway).not.toHaveBeenCalled();
  });

  it("keeps a failed record when close persistence fails, then converges on retry", async () => {
    const definition: PersistedPreviewDefinition = {
      previewId: "preview-close",
      name: "index.html",
      source: { kind: "static", rootPath: "/tmp", entryPath: "index.html" },
      tunnelProvider: "cloudflare",
      createdAt: 1,
      updatedAt: 1,
      operationId: "operation-close",
      operationFingerprint: "d".repeat(64),
    };
    const store = new MemoryStore([definition]);
    store.failSave = true;
    const events: Array<{ type: string }> = [];
    const manager = new PreviewManager({
      ...managerOptions(store),
      onEvent: (event) => events.push(event),
    });

    await expect(manager.close(definition.previewId)).rejects.toThrow("关闭预览未完成");
    expect(manager.list().previews[0]).toMatchObject({
      previewId: definition.previewId,
      state: "failed",
      error: "关闭预览未完成，请重试",
    });
    expect(events.some((event) => event.type === "removed")).toBe(false);

    store.failSave = false;
    await manager.close(definition.previewId);
    expect(manager.list().previews).toEqual([]);
    expect(events.some((event) => event.type === "removed")).toBe(true);
  });

  it("keeps the runtime identity and record until the tunnel process actually stops", async () => {
    const root = await staticFixture();
    const tunnel = createTunnel();
    Object.assign(tunnel.child, { pid: 2_000_000_000 });
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("process still running"))
      .mockResolvedValueOnce(undefined);
    tunnel.stop = stop;
    const options = managerOptions(new MemoryStore());
    const gateway = {
      originUrl: "http://127.0.0.1:45678",
      deactivate: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    options.startGateway = vi.fn(async () => gateway);
    options.runtimeRoot = root;
    options.startTunnel = vi.fn(() => tunnel);
    const manager = new PreviewManager(options);

    const created = await manager.create(
      "close-confirmed-exit",
      { kind: "static", path: root, entryPath: "index.html" },
      "cloudflare",
    );
    await vi.waitFor(() => expect(manager.list().previews[0]).toMatchObject({ state: "ready" }));

    await expect(manager.close(created.previewId)).rejects.toThrow("无法关闭预览");
    expect(manager.list().previews[0]).toMatchObject({
      previewId: created.previewId,
      state: "failed",
    });
    expect(gateway.deactivate).toHaveBeenCalledOnce();
    expect(gateway.close).not.toHaveBeenCalled();
    expect((await readdir(root)).some((entry) => entry.startsWith(created.previewId))).toBe(true);

    const accepted = Array.from({ length: 7 }, (_, index) =>
      manager.create(
        `capacity-after-stop-failure-${index}`,
        { kind: "static" as const, path: root, entryPath: "index.html" },
        "cloudflare",
      ),
    );
    expect(() =>
      manager.create(
        "capacity-after-stop-failure-8",
        { kind: "static", path: root, entryPath: "index.html" },
        "cloudflare",
      ),
    ).toThrow(/最多同时开启 8 个/);
    await Promise.all(accepted);

    await manager.close(created.previewId);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(stop.mock.invocationCallOrder[1]).toBeLessThan(
      gateway.close.mock.invocationCallOrder[0]!,
    );
    expect(manager.list().previews).toHaveLength(7);
    expect((await readdir(root)).some((entry) => entry.startsWith(created.previewId))).toBe(false);
    await manager.shutdown();
  });

  it("keeps shutdown valid when an in-flight close cannot stop its tunnel", async () => {
    const root = await staticFixture();
    const stopAttempt = deferred<void>();
    const tunnel = createTunnel();
    tunnel.stop = vi.fn(() => stopAttempt.promise);
    const gateway = {
      originUrl: "http://127.0.0.1:45678",
      deactivate: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const options = managerOptions(new MemoryStore());
    options.runtimeRoot = root;
    options.startGateway = vi.fn(async () => gateway);
    options.startTunnel = vi.fn(() => tunnel);
    const manager = new PreviewManager(options);

    const created = await manager.create(
      "shutdown-stop-failure",
      { kind: "static", path: root, entryPath: "index.html" },
      "cloudflare",
    );
    await vi.waitFor(() => expect(manager.list().previews[0]).toMatchObject({ state: "ready" }));

    const closing = manager.close(created.previewId);
    const closeResult = expect(closing).rejects.toThrow("无法关闭预览");
    const shutdown = manager.shutdown();
    stopAttempt.reject(new Error("process still running"));

    await closeResult;
    await expect(shutdown).resolves.toBeUndefined();
    expect(manager.list().previews[0]).toMatchObject({
      previewId: created.previewId,
      state: "failed",
      error: "无法关闭预览，请重试",
    });
    expect(gateway.deactivate).toHaveBeenCalledOnce();
    expect(gateway.close).not.toHaveBeenCalled();
  });
});
