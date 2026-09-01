import { describe, expect, it, vi } from "vitest";
import type {
  DevicePreviewCapability,
  DevicePreviewInput,
  DevicePreviewTarget,
} from "@dev-anywhere/shared";
import { DevicePreviewManager } from "#src/serve/device-preview/device-preview-manager.js";
import type {
  DevicePreviewBackend,
  DevicePreviewFrame,
  DevicePreviewStreamTransport,
} from "#src/serve/device-preview/types.js";

const TARGET: DevicePreviewTarget = {
  targetId: "android:emulator-5554",
  platform: "android",
  name: "Pixel 9 Pro",
  osVersion: "15",
  runtime: "API 35",
  state: "booted",
  width: 1080,
  height: 2400,
  interactive: true,
};

const SECOND_TARGET: DevicePreviewTarget = {
  ...TARGET,
  targetId: "android:emulator-5556",
  name: "Pixel 9",
};

const CAPABILITY: DevicePreviewCapability = {
  supported: true,
  ios: { supported: true, available: false, interactive: false, error: "missing" },
  android: { supported: true, available: true, interactive: true, command: "adb" },
};

interface BackendFake extends DevicePreviewBackend {
  emitFrame(frame: DevicePreviewFrame): Promise<void>;
  failCapture(error: Error): void;
  captureAborted(): boolean;
}

function backendFake(): BackendFake {
  let onFrame: ((frame: DevicePreviewFrame) => void | Promise<void>) | undefined;
  let rejectCapture: ((error: Error) => void) | undefined;
  let aborted = false;
  const capture = vi.fn(
    async (
      _targetId: string,
      signal: AbortSignal,
      callback: (frame: DevicePreviewFrame) => void | Promise<void>,
    ) => {
      onFrame = callback;
      await new Promise<void>((resolve, reject) => {
        rejectCapture = reject;
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
    },
  );
  return {
    inspectCapabilities: vi.fn(async () => CAPABILITY),
    discoverTargets: vi.fn(async () => [TARGET]),
    capture,
    sendInput: vi.fn(async () => undefined),
    releaseTarget: vi.fn(),
    dispose: vi.fn(),
    emitFrame: async (frame) => {
      if (!onFrame) throw new Error("capture has not started");
      await onFrame(frame);
    },
    failCapture: (error) => rejectCapture?.(error),
    captureAborted: () => aborted,
  };
}

function transportFake(): DevicePreviewStreamTransport {
  return { sendFrame: vi.fn(), sendComplete: vi.fn() };
}

async function createPreview(manager: DevicePreviewManager): Promise<string> {
  await manager.discoverTargets();
  return (await manager.create("operation-1", TARGET.targetId)).previewId;
}

function frame(marker: number): DevicePreviewFrame {
  return { jpeg: Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]), width: 720, height: 1600 };
}

describe("DevicePreviewManager resources", () => {
  it("deduplicates create operations and one target into one sidebar resource", async () => {
    const backend = backendFake();
    const events: unknown[] = [];
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transportFake(),
      onEvent: (event) => events.push(event),
      now: () => 100,
    });
    await manager.discoverTargets();

    const first = await manager.create("operation-1", TARGET.targetId);
    const retried = await manager.create("operation-1", TARGET.targetId);
    const sameTarget = await manager.create("operation-2", TARGET.targetId);

    expect(retried.previewId).toBe(first.previewId);
    expect(sameTarget.previewId).toBe(first.previewId);
    expect(manager.list()).toMatchObject({
      revision: 1,
      previews: [{ previewId: first.previewId, state: "ready", interactive: true }],
    });
    expect(events).toHaveLength(1);
  });

  it("bounds remembered operation ids while preserving in-flight create idempotency", async () => {
    const backend = backendFake();
    vi.mocked(backend.discoverTargets).mockResolvedValue([TARGET, SECOND_TARGET]);
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    await manager.discoverTargets();

    const first = await manager.create("operation-0", TARGET.targetId);
    for (let index = 1; index <= 128; index += 1) {
      await manager.create(`operation-${index}`, TARGET.targetId);
    }
    const reusedEvictedId = await manager.create("operation-0", SECOND_TARGET.targetId);

    expect(reusedEvictedId.previewId).not.toBe(first.previewId);
    expect(manager.list().previews).toHaveLength(2);

    let finishDiscovery!: (targets: DevicePreviewTarget[]) => void;
    vi.mocked(backend.discoverTargets).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    const secondManager = new DevicePreviewManager({
      backend,
      streamTransport: transportFake(),
    });
    const pendingFirst = secondManager.create("same-operation", TARGET.targetId);
    const pendingRetry = secondManager.create("same-operation", TARGET.targetId);
    finishDiscovery([TARGET]);

    const [created, retried] = await Promise.all([pendingFirst, pendingRetry]);
    expect(retried.previewId).toBe(created.previewId);
  });

  it("closing a preview stops capture resources but never disposes or shuts down the simulator", async () => {
    const backend = backendFake();
    const events: Array<{ type: string }> = [];
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transportFake(),
      onEvent: (event) => events.push(event),
    });
    const previewId = await createPreview(manager);
    await manager.startStream({ streamId: "stream-1", leaseId: "lease-1", previewId });

    manager.close(previewId);
    await vi.waitFor(() => expect(backend.captureAborted()).toBe(true));

    expect(manager.list().previews).toEqual([]);
    expect(backend.dispose).not.toHaveBeenCalled();
    expect(backend.releaseTarget).toHaveBeenCalledWith(TARGET.targetId);
    expect(events.at(-1)).toMatchObject({ type: "removed" });
  });

  it("does not resurrect a preview when close wins a pending reconnect", async () => {
    const backend = backendFake();
    const events: Array<{ type: string; revision: number }> = [];
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transportFake(),
      onEvent: (event) => events.push(event),
    });
    const previewId = await createPreview(manager);
    vi.mocked(backend.discoverTargets).mockResolvedValueOnce([]);
    await manager.discoverTargets();

    let finishReconnect!: (targets: DevicePreviewTarget[]) => void;
    vi.mocked(backend.discoverTargets).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReconnect = resolve;
        }),
    );
    const reconnecting = manager.reconnect(previewId);
    await vi.waitFor(() => expect(finishReconnect).toBeTypeOf("function"));
    manager.close(previewId);
    const removedRevision = events.at(-1)?.revision;
    finishReconnect([TARGET]);

    await expect(reconnecting).rejects.toThrow("已关闭");
    expect(manager.list().previews).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "removed", revision: removedRevision });
  });
});

describe("DevicePreviewManager shared capture and backpressure", () => {
  it("caps all active viewers at eight while allowing idempotent start retries", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);

    for (let index = 0; index < 8; index += 1) {
      await manager.startStream({
        streamId: `stream-${index}`,
        leaseId: `lease-${index}`,
        previewId,
      });
    }
    await expect(
      manager.startStream({ streamId: "stream-0", leaseId: "lease-0", previewId }),
    ).resolves.toMatchObject({ streamId: "stream-0" });
    await expect(
      manager.startStream({ streamId: "stream-8", leaseId: "lease-8", previewId }),
    ).rejects.toThrow("最多可同时打开 8 个设备画面");
    expect(backend.capture).toHaveBeenCalledOnce();

    manager.stopStream("stream-0");
    await expect(
      manager.startStream({ streamId: "stream-8", leaseId: "lease-8", previewId }),
    ).resolves.toMatchObject({ streamId: "stream-8" });
    for (let index = 1; index <= 8; index += 1) manager.stopStream(`stream-${index}`);
  });

  it("reserves the global viewer limit for pending starts without charging retries twice", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    vi.mocked(backend.discoverTargets).mockResolvedValueOnce([]);
    await manager.discoverTargets();

    const finishDiscoveries: Array<(targets: DevicePreviewTarget[]) => void> = [];
    vi.mocked(backend.discoverTargets).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDiscoveries.push(resolve);
        }),
    );
    const pending = Array.from({ length: 8 }, (_, index) =>
      manager.startStream({
        streamId: `pending-stream-${index}`,
        leaseId: `pending-lease-${index}`,
        previewId,
      }),
    );
    const retry = manager.startStream({
      streamId: "pending-stream-0",
      leaseId: "pending-lease-0",
      previewId,
    });
    const results = Promise.allSettled([...pending, retry]);
    await vi.waitFor(() => expect(finishDiscoveries).toHaveLength(8));

    await expect(
      manager.startStream({
        streamId: "pending-stream-8",
        leaseId: "pending-lease-8",
        previewId,
      }),
    ).rejects.toThrow("最多可同时打开 8 个设备画面");
    expect(finishDiscoveries).toHaveLength(8);

    manager.disconnectTransport();
    for (const finish of finishDiscoveries) finish([TARGET]);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(backend.capture).not.toHaveBeenCalled();
  });

  it("accepts only the capture profile the adapters actually produce", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);

    await expect(
      manager.startStream({
        streamId: "stream-wide",
        leaseId: "lease-wide",
        previewId,
        maxWidth: 960,
        jpegQuality: 70,
      }),
    ).rejects.toThrow("仅支持 720px、JPEG 质量 70");
    await expect(
      manager.startStream({
        streamId: "stream-quality",
        leaseId: "lease-quality",
        previewId,
        maxWidth: 720,
        jpegQuality: 80,
      }),
    ).rejects.toThrow("仅支持 720px、JPEG 质量 70");

    await expect(
      manager.startStream({
        streamId: "stream-default",
        leaseId: "lease-default",
        previewId,
        maxWidth: 720,
        jpegQuality: 70,
      }),
    ).resolves.toMatchObject({ streamId: "stream-default" });
    expect(backend.capture).toHaveBeenCalledOnce();
  });

  it("shares one device capture across viewers and retains only each viewer's latest pending frame", async () => {
    const backend = backendFake();
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transport = transportFake();
    vi.mocked(transport.sendFrame).mockImplementationOnce(() => firstPending);
    let now = 1_000;
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transport,
      now: () => (now += 100),
    });
    const previewId = await createPreview(manager);
    await manager.startStream({
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId,
      maxFps: 30,
    });
    await manager.startStream({
      streamId: "stream-2",
      leaseId: "lease-2",
      previewId,
      maxFps: 30,
    });

    expect(backend.capture).toHaveBeenCalledTimes(1);
    await backend.emitFrame(frame(1));
    await backend.emitFrame(frame(2));
    await backend.emitFrame(frame(3));
    expect(transport.sendFrame).toHaveBeenCalledTimes(4);

    releaseFirst();
    await vi.waitFor(() => expect(transport.sendFrame).toHaveBeenCalledTimes(5));
    const streamOneFrames = vi
      .mocked(transport.sendFrame)
      .mock.calls.filter((call) => call[0] === "stream-1");
    expect(streamOneFrames).toHaveLength(2);
    expect(Buffer.from(streamOneFrames[1]![2]).includes(3)).toBe(true);

    manager.stopStream("stream-1");
    expect(backend.captureAborted()).toBe(false);
    expect(backend.releaseTarget).not.toHaveBeenCalled();
    manager.stopStream("stream-2");
    await vi.waitFor(() => expect(backend.captureAborted()).toBe(true));
    expect(backend.releaseTarget).toHaveBeenCalledOnce();
  });

  it("immediately gives a later viewer the shared capture's latest frame", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    const previewId = await createPreview(manager);
    await manager.startStream({
      streamId: "early-stream",
      leaseId: "early-lease",
      previewId,
    });
    const latest = frame(7);
    await backend.emitFrame(latest);
    expect(transport.sendFrame).toHaveBeenCalledWith("early-stream", 0, latest.jpeg);

    await manager.startStream({
      streamId: "late-stream",
      leaseId: "late-lease",
      previewId,
    });

    expect(backend.capture).toHaveBeenCalledOnce();
    expect(transport.sendFrame).toHaveBeenCalledWith("late-stream", 0, latest.jpeg);
    const lateFrame = vi
      .mocked(transport.sendFrame)
      .mock.calls.find(([streamId]) => streamId === "late-stream");
    expect(lateFrame?.[2]).toBe(latest.jpeg);
    manager.stopStream("early-stream");
    manager.stopStream("late-stream");
  });

  it.each(["stop", "disconnect", "close"] as const)(
    "%s cancels a stream start that is awaiting target discovery",
    async (action) => {
      const backend = backendFake();
      const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
      const previewId = await createPreview(manager);
      vi.mocked(backend.discoverTargets).mockResolvedValueOnce([]);
      await manager.discoverTargets();

      let finishDiscovery!: (targets: DevicePreviewTarget[]) => void;
      vi.mocked(backend.discoverTargets).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishDiscovery = resolve;
          }),
      );
      const starting = manager.startStream({
        streamId: "pending-stream",
        leaseId: "pending-lease",
        previewId,
      });
      const rejection = expect(starting).rejects.toThrow("启动已取消");
      await vi.waitFor(() => expect(finishDiscovery).toBeTypeOf("function"));

      if (action === "stop") manager.stopStream("pending-stream");
      else if (action === "disconnect") manager.disconnectTransport();
      else manager.close(previewId);
      finishDiscovery([TARGET]);

      await rejection;
      expect(backend.capture).not.toHaveBeenCalled();
    },
  );

  it("holds the latest frame while Relay flow control is paused and flushes it on resume", async () => {
    const backend = backendFake();
    const transport = transportFake();
    let now = 1_000;
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transport,
      now: () => (now += 100),
    });
    const previewId = await createPreview(manager);
    await manager.startStream({ streamId: "stream-1", leaseId: "lease-1", previewId });

    manager.setFlowPaused("stream-1", true);
    await backend.emitFrame(frame(1));
    await backend.emitFrame(frame(2));
    expect(transport.sendFrame).not.toHaveBeenCalled();

    manager.setFlowPaused("stream-1", false);
    await vi.waitFor(() => expect(transport.sendFrame).toHaveBeenCalledOnce());
    expect(Buffer.from(vi.mocked(transport.sendFrame).mock.calls[0]![2]).includes(2)).toBe(true);
  });

  it("completes every viewer and marks the resource failed when shared capture fails", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    const previewId = await createPreview(manager);
    await manager.startStream({ streamId: "stream-1", leaseId: "lease-1", previewId });
    await manager.startStream({ streamId: "stream-2", leaseId: "lease-2", previewId });

    backend.failCapture(new Error("capture unavailable"));
    await vi.waitFor(() => expect(transport.sendComplete).toHaveBeenCalledTimes(2));

    expect(manager.list().previews[0]).toMatchObject({
      previewId,
      state: "failed",
      error: "capture unavailable",
    });
  });
});

describe("DevicePreviewManager input lease", () => {
  it("deduplicates input sequence numbers and serializes input across leases for one target", async () => {
    const backend = backendFake();
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(backend.sendInput).mockImplementationOnce(() => firstPending);
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transportFake(),
    });
    const previewId = await createPreview(manager);
    await manager.startStream({ streamId: "stream-1", leaseId: "lease-1", previewId });
    await manager.startStream({ streamId: "stream-2", leaseId: "lease-2", previewId });
    const tap: DevicePreviewInput = { kind: "tap", x: 0.5, y: 0.5 };

    const first = manager.sendInput("lease-1", 7, tap);
    const duplicate = manager.sendInput("lease-1", 7, tap);
    const secondLease = manager.sendInput("lease-2", 1, { kind: "button", button: "home" });
    await vi.waitFor(() => expect(backend.sendInput).toHaveBeenCalledOnce());
    expect(first).toBe(duplicate);
    expect(backend.sendInput).toHaveBeenCalledWith(TARGET.targetId, tap, expect.any(AbortSignal));

    releaseFirst();
    await Promise.all([first, duplicate, secondLease]);
    expect(backend.sendInput).toHaveBeenCalledTimes(2);
  });

  it("invalidates stopped leases before queued input reaches the adapter", async () => {
    const backend = backendFake();
    let releaseFirst!: () => void;
    vi.mocked(backend.sendInput).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await manager.startStream({ streamId: "stream-1", leaseId: "lease-1", previewId });
    await manager.startStream({ streamId: "stream-2", leaseId: "lease-2", previewId });

    const first = manager.sendInput("lease-1", 1, { kind: "button", button: "home" });
    const queued = manager.sendInput("lease-2", 1, { kind: "button", button: "back" });
    await vi.waitFor(() => expect(backend.sendInput).toHaveBeenCalledOnce());
    manager.stopStream("stream-2");
    releaseFirst();

    await first;
    await expect(queued).rejects.toThrow("租约已失效");
    expect(backend.sendInput).toHaveBeenCalledTimes(1);
  });

  it("aborts revoked input without stopping its viewer and lets the same lease resume later", async () => {
    const backend = backendFake();
    vi.mocked(backend.sendInput)
      .mockImplementationOnce(
        (_targetId, _input, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      )
      .mockResolvedValue(undefined);
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await manager.startStream({ streamId: "stream-1", leaseId: "lease-1", previewId });

    const running = manager.sendInput("lease-1", 1, { kind: "button", button: "home" });
    const queued = manager.sendInput("lease-1", 2, { kind: "button", button: "back" });
    const oldResults = Promise.allSettled([running, queued]);
    await vi.waitFor(() => expect(backend.sendInput).toHaveBeenCalledOnce());

    manager.revokeInput("lease-1");

    expect(await oldResults).toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
    expect(backend.sendInput).toHaveBeenCalledOnce();
    expect(manager.hasLease("lease-1")).toBe(true);

    // Revocation starts a new input epoch. Reusing sequence 1 after regaining control is valid.
    await expect(
      manager.sendInput("lease-1", 1, { kind: "tap", x: 0.25, y: 0.75 }),
    ).resolves.toBeUndefined();
    expect(backend.sendInput).toHaveBeenCalledTimes(2);
  });

  it("caps pending input per lease before the adapter queue can grow without bound", async () => {
    const backend = backendFake();
    vi.mocked(backend.sendInput).mockImplementation(
      (_targetId, _input, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await manager.startStream({ streamId: "stream-1", leaseId: "lease-1", previewId });

    const accepted = Array.from({ length: 32 }, (_, index) =>
      manager.sendInput("lease-1", index + 1, { kind: "tap", x: 0.5, y: 0.5 }),
    );
    const acceptedResults = Promise.allSettled(accepted);

    await expect(manager.sendInput("lease-1", 33, { kind: "tap", x: 0.5, y: 0.5 })).rejects.toThrow(
      "设备输入队列已满",
    );
    await vi.waitFor(() => expect(backend.sendInput).toHaveBeenCalledOnce());

    manager.revokeInput("lease-1");
    expect((await acceptedResults).every((result) => result.status === "rejected")).toBe(true);
    expect(backend.sendInput).toHaveBeenCalledOnce();
    expect(manager.hasLease("lease-1")).toBe(true);
  });
});

describe("DevicePreviewManager shutdown", () => {
  it("stops capture helpers and backend resources without invoking simulator lifecycle APIs", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await manager.startStream({ streamId: "stream-1", leaseId: "lease-1", previewId });

    await manager.shutdown();

    expect(backend.captureAborted()).toBe(true);
    expect(backend.dispose).toHaveBeenCalledOnce();
    await expect(manager.startStream({ streamId: "x", leaseId: "x", previewId })).rejects.toThrow(
      "Proxy 正在停止",
    );
  });

  it("cancels and awaits a pending stream start before disposing the backend", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    vi.mocked(backend.discoverTargets).mockResolvedValueOnce([]);
    await manager.discoverTargets();

    let finishDiscovery!: (targets: DevicePreviewTarget[]) => void;
    vi.mocked(backend.discoverTargets).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    const starting = manager.startStream({
      streamId: "pending-stream",
      leaseId: "pending-lease",
      previewId,
    });
    const rejection = expect(starting).rejects.toThrow("Proxy 正在停止");
    await vi.waitFor(() => expect(finishDiscovery).toBeTypeOf("function"));
    const shutdown = manager.shutdown();
    const concurrentShutdown = manager.shutdown();
    let shutdownSettled = false;
    void concurrentShutdown.then(() => {
      shutdownSettled = true;
    });
    expect(concurrentShutdown).toBe(shutdown);
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(backend.dispose).not.toHaveBeenCalled();
    finishDiscovery([TARGET]);

    await Promise.all([rejection, shutdown, concurrentShutdown]);
    expect(shutdownSettled).toBe(true);
    expect(backend.capture).not.toHaveBeenCalled();
    expect(backend.dispose).toHaveBeenCalledOnce();
  });
});
