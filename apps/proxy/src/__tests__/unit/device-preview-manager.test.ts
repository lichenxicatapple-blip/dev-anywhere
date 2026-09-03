import { describe, expect, it, vi } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import type {
  DevicePreviewCapability,
  DevicePreviewInput,
  DevicePreviewTarget,
} from "@dev-anywhere/shared";
import { DevicePreviewManager } from "#src/serve/device-preview/device-preview-manager.js";
import type {
  DevicePreviewBackend,
  DevicePreviewFrame,
  DevicePreviewJpegFrame,
  DevicePreviewStreamTransport,
} from "#src/serve/device-preview/types.js";

const TARGET: DevicePreviewTarget = {
  targetId: "ios:simulator-one",
  platform: "ios",
  name: "iPhone 17 Pro",
  model: "iPhone 17 Pro",
  osVersion: "15",
  width: 1080,
  height: 2400,
  interactive: true,
};

const SECOND_TARGET: DevicePreviewTarget = {
  ...TARGET,
  targetId: "ios:simulator-two",
  name: "iPhone Air",
  model: "iPhone Air",
};

const ANDROID_TARGET: DevicePreviewTarget = {
  targetId: "android:emulator-5554",
  platform: "android",
  name: "Pixel 9 Pro",
  model: "Pixel 9 Pro",
  osVersion: "16",
  width: 1080,
  height: 2400,
  interactive: true,
};

const CAPABILITY: DevicePreviewCapability = {
  ios: { supported: true, available: false, interactive: false, error: "missing" },
  android: { supported: true, available: true, interactive: true, command: "adb" },
};

interface BackendFake extends DevicePreviewBackend {
  releaseInput(targetId: string): Promise<void>;
  releaseTarget(targetId: string): void;
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
    requestKeyframe: vi.fn(async () => undefined),
    sendInput: vi.fn(async () => undefined),
    releaseInput: vi.fn(async () => undefined),
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
  return { sendFrame: vi.fn(), sendH264Packet: vi.fn(), sendComplete: vi.fn() };
}

function startJpegStream(
  manager: DevicePreviewManager,
  streamId: string,
  leaseId: string,
  previewId: string,
) {
  return manager.startStream({ streamId, leaseId, previewId, format: "jpeg" });
}

async function createPreview(manager: DevicePreviewManager): Promise<string> {
  await manager.discoverTargets();
  return (await manager.create(TARGET.targetId)).previewId;
}

function frame(marker: number): DevicePreviewJpegFrame {
  return {
    format: "jpeg",
    jpeg: Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]),
  };
}

function h264Configuration(marker = 0x67): DevicePreviewFrame {
  return {
    format: "h264_annex_b",
    kind: "configuration",
    keyframe: false,
    durationMs: 0,
    data: Buffer.from([0, 0, 0, 1, marker]),
  };
}

function h264Frame(marker: number, keyframe = false): DevicePreviewFrame {
  return {
    format: "h264_annex_b",
    kind: "frame",
    keyframe,
    durationMs: 33,
    data: Buffer.from([0, 0, 0, 1, marker]),
  };
}

describe("DevicePreviewManager resources", () => {
  it("deduplicates one target into one sidebar resource", async () => {
    const backend = backendFake();
    const events: unknown[] = [];
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transportFake(),
      onEvent: (event) => events.push(event),
      now: () => 100,
    });
    await manager.discoverTargets();

    const first = await manager.create(TARGET.targetId);
    const retried = await manager.create(TARGET.targetId);
    const sameTarget = await manager.create(TARGET.targetId);

    expect(retried.previewId).toBe(first.previewId);
    expect(sameTarget.previewId).toBe(first.previewId);
    expect(manager.list()).toMatchObject({
      revision: 1,
      previews: [
        {
          previewId: first.previewId,
          state: "ready",
          interactive: true,
        },
      ],
    });
    expect(events).toHaveLength(1);
  });

  it("keeps custom names across state changes and renames without restarting the stream", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const events: Array<{ type: string; revision: number; preview?: { name: string } }> = [];
    let now = 100;
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transport,
      onEvent: (event) => events.push(event),
      now: () => now,
    });
    await manager.discoverTargets();
    const created = await manager.create(TARGET.targetId, "  QA phone  ");
    expect(created).toMatchObject({
      name: "QA phone",
      model: TARGET.model,
      osVersion: TARGET.osVersion,
      updatedAt: 100,
    });
    await manager.startStream({
      streamId: "named-stream",
      leaseId: "named-lease",
      previewId: created.previewId,
      format: "jpeg",
    });
    expect(backend.capture).toHaveBeenCalledOnce();

    now = 200;
    const renamed = manager.rename(created.previewId, "  Checkout flow  ");

    expect(renamed).toMatchObject({
      name: "Checkout flow",
      state: "ready",
      updatedAt: 200,
    });
    expect(manager.list()).toMatchObject({
      revision: 2,
      previews: [{ name: "Checkout flow" }],
    });
    expect(events.at(-1)).toMatchObject({
      type: "state",
      revision: 2,
      preview: { name: "Checkout flow" },
    });
    expect(backend.capture).toHaveBeenCalledOnce();
    expect(backend.captureAborted()).toBe(false);
    expect(transport.sendComplete).not.toHaveBeenCalled();

    expect(() => manager.rename(created.previewId, "  ")).toThrow("预览名称不能为空");
    expect(() => manager.rename(created.previewId, "bad\tname")).toThrow("不能包含控制字符");
    manager.stopStream("named-stream");
    await manager.shutdown();
  });

  it("falls back to the target name when a create name is blank", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    await manager.discoverTargets();

    const created = await manager.create(TARGET.targetId, " \t ");

    expect(created.name).toBe(TARGET.name);
    await manager.shutdown();
  });

  it("refreshes device metadata without replacing the preview name", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    await manager.discoverTargets();
    const created = await manager.create(TARGET.targetId, "Checkout flow");
    vi.mocked(backend.discoverTargets).mockResolvedValueOnce([
      {
        ...TARGET,
        name: "Renamed simulator",
        model: "iPhone 18 Pro",
        osVersion: "27.0",
      },
    ]);

    await manager.reconnect(created.previewId);

    expect(manager.list().previews[0]).toMatchObject({
      name: "Checkout flow",
      model: "iPhone 18 Pro",
      osVersion: "27.0",
    });
  });

  it("does not disconnect an active preview when target discovery fails", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    vi.mocked(backend.discoverTargets).mockRejectedValueOnce(new Error("transient probe failure"));

    await expect(manager.discoverTargets()).rejects.toThrow("transient probe failure");

    expect(manager.list().previews).toEqual([
      expect.objectContaining({ previewId, state: "ready" }),
    ]);
    expect(backend.captureAborted()).toBe(false);
    expect(transport.sendComplete).not.toHaveBeenCalled();
    manager.stopStream("stream-1");
    await manager.shutdown();
  });

  it("does not let a slow older discovery overwrite a faster newer snapshot", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    let finishSlow!: (targets: DevicePreviewTarget[]) => void;
    const slowStarted = new Promise<void>((resolve) => {
      vi.mocked(backend.discoverTargets).mockImplementationOnce(
        () =>
          new Promise((finish) => {
            finishSlow = finish;
            resolve();
          }),
      );
    });
    const currentTarget = {
      ...TARGET,
      name: "Current simulator",
      model: "iPhone 18 Pro",
      osVersion: "27.0",
    };
    vi.mocked(backend.discoverTargets).mockResolvedValueOnce([currentTarget]);

    const slowDiscovery = manager.discoverTargets();
    await slowStarted;
    await expect(manager.discoverTargets()).resolves.toEqual([currentTarget]);
    finishSlow([]);

    await expect(slowDiscovery).resolves.toEqual([currentTarget]);
    expect(manager.list().previews).toEqual([
      expect.objectContaining({
        previewId,
        state: "ready",
        model: "iPhone 18 Pro",
        osVersion: "27.0",
      }),
    ]);
  });

  it("keeps create joined through repeated discovery supersession", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    let finishCreateDiscovery!: (targets: DevicePreviewTarget[]) => void;
    let finishMiddleDiscovery!: (targets: DevicePreviewTarget[]) => void;
    let finishNewestDiscovery!: (targets: DevicePreviewTarget[]) => void;
    const createDiscoveryStarted = new Promise<void>((resolve) => {
      vi.mocked(backend.discoverTargets).mockImplementationOnce(
        () =>
          new Promise((finish) => {
            finishCreateDiscovery = finish;
            resolve();
          }),
      );
    });
    const middleDiscoveryStarted = new Promise<void>((resolve) => {
      vi.mocked(backend.discoverTargets).mockImplementationOnce(
        () =>
          new Promise((finish) => {
            finishMiddleDiscovery = finish;
            resolve();
          }),
      );
    });
    const newestDiscoveryStarted = new Promise<void>((resolve) => {
      vi.mocked(backend.discoverTargets).mockImplementationOnce(
        () =>
          new Promise((finish) => {
            finishNewestDiscovery = finish;
            resolve();
          }),
      );
    });

    const creating = manager.create(TARGET.targetId);
    await createDiscoveryStarted;
    const middleDiscovery = manager.discoverTargets(true);
    await middleDiscoveryStarted;
    let createSettled = false;
    void creating.then(
      () => {
        createSettled = true;
      },
      () => {
        createSettled = true;
      },
    );

    finishCreateDiscovery([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createSettled).toBe(false);

    const newestDiscovery = manager.discoverTargets(true);
    await newestDiscoveryStarted;
    finishMiddleDiscovery([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createSettled).toBe(false);

    finishNewestDiscovery([TARGET]);
    await expect(newestDiscovery).resolves.toEqual([TARGET]);
    await expect(middleDiscovery).resolves.toEqual([TARGET]);
    await expect(creating).resolves.toMatchObject({ targetId: TARGET.targetId, state: "ready" });
  });

  it("deduplicates concurrent creates by target", async () => {
    const backend = backendFake();
    vi.mocked(backend.discoverTargets).mockResolvedValue([TARGET, SECOND_TARGET]);
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const pendingFirst = manager.create(TARGET.targetId);
    const pendingRetry = manager.create(TARGET.targetId);

    const [created, retried] = await Promise.all([pendingFirst, pendingRetry]);
    expect(retried.previewId).toBe(created.previewId);
    expect(manager.list().previews).toHaveLength(1);
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
    await manager.startStream({
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId,
      format: "jpeg",
    });

    manager.close(previewId);
    await vi.waitFor(() => expect(backend.captureAborted()).toBe(true));

    expect(manager.list().previews).toEqual([]);
    expect(backend.dispose).not.toHaveBeenCalled();
    expect(backend.releaseTarget).toHaveBeenCalledWith(TARGET.targetId);
    expect(events.at(-1)).toMatchObject({ type: "removed" });
  });

  it("releases an active touch and its target exactly once when the preview closes", async () => {
    const backend = backendFake();
    let finishRelease!: () => void;
    vi.mocked(backend.releaseInput).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 0.5,
    });

    manager.close(previewId);
    await vi.waitFor(() => expect(backend.releaseInput).toHaveBeenCalledOnce());
    expect(backend.releaseTarget).not.toHaveBeenCalled();

    finishRelease();
    await vi.waitFor(() => expect(backend.releaseTarget).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(backend.releaseTarget).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared capture alive until close releases its active touch", async () => {
    const backend = backendFake();
    let finishRelease!: () => void;
    vi.mocked(backend.releaseInput).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await startJpegStream(manager, "stream-2", "lease-2", previewId);
    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 0.5,
    });

    manager.close(previewId);
    await vi.waitFor(() => expect(backend.releaseInput).toHaveBeenCalledOnce());
    expect(backend.captureAborted()).toBe(false);

    finishRelease();
    await vi.waitFor(() => expect(backend.captureAborted()).toBe(true));
    expect(vi.mocked(backend.releaseInput).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(backend.releaseTarget).mock.invocationCallOrder[0]!,
    );
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
        format: "jpeg",
      });
    }
    await expect(
      manager.startStream({
        streamId: "stream-0",
        leaseId: "lease-0",
        previewId,
        format: "jpeg",
      }),
    ).resolves.toMatchObject({ streamId: "stream-0" });
    await expect(
      manager.startStream({
        streamId: "stream-8",
        leaseId: "lease-8",
        previewId,
        format: "jpeg",
      }),
    ).rejects.toMatchObject({
      message: "每台开发机最多可同时打开 8 个设备画面",
      errorCode: ControlErrorCode.STREAM_CAPACITY_EXCEEDED,
    });
    expect(backend.capture).toHaveBeenCalledOnce();

    manager.stopStream("stream-0");
    await expect(
      manager.startStream({
        streamId: "stream-8",
        leaseId: "lease-8",
        previewId,
        format: "jpeg",
      }),
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
        format: "jpeg",
      }),
    );
    const retry = manager.startStream({
      streamId: "pending-stream-0",
      leaseId: "pending-lease-0",
      previewId,
      format: "jpeg",
    });
    const results = Promise.allSettled([...pending, retry]);
    await vi.waitFor(() => expect(finishDiscoveries).toHaveLength(8));

    await expect(
      manager.startStream({
        streamId: "pending-stream-8",
        leaseId: "pending-lease-8",
        previewId,
        format: "jpeg",
      }),
    ).rejects.toMatchObject({
      message: "每台开发机最多可同时打开 8 个设备画面",
      errorCode: ControlErrorCode.STREAM_CAPACITY_EXCEEDED,
    });
    expect(finishDiscoveries).toHaveLength(8);

    manager.disconnectTransport();
    for (const finish of finishDiscoveries) finish([TARGET]);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(backend.capture).not.toHaveBeenCalled();
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
      format: "jpeg",
      maxFps: 30,
    });
    await manager.startStream({
      streamId: "stream-2",
      leaseId: "lease-2",
      previewId,
      format: "jpeg",
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
      format: "jpeg",
    });
    const latest = frame(7);
    await backend.emitFrame(latest);
    expect(transport.sendFrame).toHaveBeenCalledWith("early-stream", 0, latest.jpeg);

    await manager.startStream({
      streamId: "late-stream",
      leaseId: "late-lease",
      previewId,
      format: "jpeg",
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
        format: "jpeg",
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
    await manager.startStream({
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId,
      format: "jpeg",
    });

    manager.setFlowPaused("stream-1", true, false);
    await backend.emitFrame(frame(1));
    await backend.emitFrame(frame(2));
    expect(transport.sendFrame).not.toHaveBeenCalled();

    manager.setFlowPaused("stream-1", false, false);
    await vi.waitFor(() => expect(transport.sendFrame).toHaveBeenCalledOnce());
    expect(Buffer.from(vi.mocked(transport.sendFrame).mock.calls[0]![2]).includes(2)).toBe(true);
  });

  it("replays the capture's latest JPEG when flow control resumes after an in-flight frame", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    const previewId = await createPreview(manager);
    await manager.startStream({
      streamId: "stream-replay",
      leaseId: "lease-replay",
      previewId,
      format: "jpeg",
    });

    await backend.emitFrame(frame(7));
    await vi.waitFor(() => expect(transport.sendFrame).toHaveBeenCalledOnce());
    manager.setFlowPaused("stream-replay", true, false);
    manager.setFlowPaused("stream-replay", false, false);

    await vi.waitFor(() => expect(transport.sendFrame).toHaveBeenCalledTimes(2));
    expect(Buffer.from(vi.mocked(transport.sendFrame).mock.calls[1]![2]).includes(7)).toBe(true);
  });

  it("streams Android only as ordered H.264 and resynchronizes after flow control", async () => {
    const backend = backendFake();
    vi.mocked(backend.discoverTargets).mockResolvedValue([ANDROID_TARGET]);
    const transport = transportFake();
    const sendH264Packet = vi.mocked(transport.sendH264Packet!);
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    await manager.discoverTargets();
    const previewId = (await manager.create(ANDROID_TARGET.targetId)).previewId;

    await expect(
      manager.startStream({
        streamId: "jpeg-stream",
        leaseId: "jpeg-lease",
        previewId,
        format: "jpeg",
      }),
    ).rejects.toThrow("仅支持 H.264");
    await manager.startStream({
      streamId: "h264-stream",
      leaseId: "h264-lease",
      previewId,
      format: "h264_annex_b",
    });

    await backend.emitFrame(h264Configuration());
    await backend.emitFrame(h264Frame(0x41));
    expect(sendH264Packet).not.toHaveBeenCalled();
    await backend.emitFrame(h264Frame(0x65, true));
    await vi.waitFor(() => expect(sendH264Packet).toHaveBeenCalledTimes(2));
    expect(sendH264Packet.mock.calls.map((call) => call[2].kind)).toEqual([
      "configuration",
      "frame",
    ]);
    expect(sendH264Packet.mock.calls[1]?.[2].keyframe).toBe(true);
    expect(transport.sendFrame).not.toHaveBeenCalled();

    manager.setFlowPaused("h264-stream", true, false);
    await backend.emitFrame(h264Frame(0x41));
    manager.setFlowPaused("h264-stream", false, false);
    await vi.waitFor(() =>
      expect(backend.requestKeyframe).toHaveBeenCalledWith(ANDROID_TARGET.targetId),
    );
    await backend.emitFrame(h264Frame(0x41));
    expect(sendH264Packet).toHaveBeenCalledTimes(2);
    await backend.emitFrame(h264Configuration(0x68));
    await backend.emitFrame(h264Frame(0x65, true));
    await vi.waitFor(() => expect(sendH264Packet).toHaveBeenCalledTimes(4));
    expect(sendH264Packet.mock.calls.slice(2).map((call) => call[2].kind)).toEqual([
      "configuration",
      "frame",
    ]);
  });

  it("keeps an H.264 viewer synchronized when HTTP backpressure drains without dropping a packet", async () => {
    const backend = backendFake();
    vi.mocked(backend.discoverTargets).mockResolvedValue([ANDROID_TARGET]);
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    await manager.discoverTargets();
    const previewId = (await manager.create(ANDROID_TARGET.targetId)).previewId;
    await manager.startStream({
      streamId: "h264-stream",
      leaseId: "h264-lease",
      previewId,
      format: "h264_annex_b",
    });
    await backend.emitFrame(h264Configuration());
    await backend.emitFrame(h264Frame(0x65, true));
    await vi.waitFor(() => expect(transport.sendH264Packet).toHaveBeenCalledTimes(2));
    vi.mocked(backend.requestKeyframe).mockClear();

    manager.setFlowPaused("h264-stream", true, false);
    manager.setFlowPaused("h264-stream", false, false);
    await Promise.resolve();

    expect(backend.requestKeyframe).not.toHaveBeenCalled();
    await backend.emitFrame(h264Frame(0x41));
    await vi.waitFor(() => expect(transport.sendH264Packet).toHaveBeenCalledTimes(3));
  });

  it("actively resets Scrcpy so a later H.264 viewer receives a fresh decodable GOP", async () => {
    const backend = backendFake();
    vi.mocked(backend.discoverTargets).mockResolvedValue([ANDROID_TARGET]);
    const transport = transportFake();
    const sendH264Packet = vi.mocked(transport.sendH264Packet);
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    await manager.discoverTargets();
    const previewId = (await manager.create(ANDROID_TARGET.targetId)).previewId;
    await manager.startStream({
      streamId: "early-stream",
      leaseId: "early-lease",
      previewId,
      format: "h264_annex_b",
    });
    await backend.emitFrame(h264Configuration());
    await backend.emitFrame(h264Frame(0x65, true));
    await vi.waitFor(() => expect(sendH264Packet).toHaveBeenCalledTimes(2));

    await manager.startStream({
      streamId: "late-stream",
      leaseId: "late-lease",
      previewId,
      format: "h264_annex_b",
    });
    await vi.waitFor(() =>
      expect(backend.requestKeyframe).toHaveBeenCalledWith(ANDROID_TARGET.targetId),
    );
    await backend.emitFrame(h264Frame(0x41));
    expect(sendH264Packet.mock.calls.some(([streamId]) => streamId === "late-stream")).toBe(false);

    await backend.emitFrame(h264Configuration(0x68));
    await backend.emitFrame(h264Frame(0x65, true));
    await vi.waitFor(() => {
      const latePackets = sendH264Packet.mock.calls.filter(
        ([streamId]) => streamId === "late-stream",
      );
      expect(latePackets.map((call) => call[2].kind)).toEqual(["configuration", "frame"]);
      expect(latePackets[1]?.[2].keyframe).toBe(true);
    });
  });

  it("drops an overflowing H.264 queue and requests a fresh GOP", async () => {
    const backend = backendFake();
    vi.mocked(backend.discoverTargets).mockResolvedValue([ANDROID_TARGET]);
    const transport = transportFake();
    let releaseFirstSend!: () => void;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    vi.mocked(transport.sendH264Packet).mockImplementationOnce(() => firstSend);
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    await manager.discoverTargets();
    const previewId = (await manager.create(ANDROID_TARGET.targetId)).previewId;
    await manager.startStream({
      streamId: "h264-stream",
      leaseId: "h264-lease",
      previewId,
      format: "h264_annex_b",
    });

    await backend.emitFrame(h264Configuration());
    await backend.emitFrame(h264Frame(0x65, true));
    for (let marker = 1; marker <= 4; marker += 1) {
      await backend.emitFrame(h264Frame(0x40 + marker));
    }
    await vi.waitFor(() =>
      expect(backend.requestKeyframe).toHaveBeenCalledWith(ANDROID_TARGET.targetId),
    );

    await backend.emitFrame(h264Configuration(0x68));
    await backend.emitFrame(h264Frame(0x65, true));
    releaseFirstSend();
    await vi.waitFor(() => expect(transport.sendH264Packet).toHaveBeenCalledTimes(3));
    expect(
      vi
        .mocked(transport.sendH264Packet)
        .mock.calls.slice(1)
        .map((call) => call[2].kind),
    ).toEqual(["configuration", "frame"]);
  });

  it("fails only viewers awaiting a recovery keyframe and keeps synced viewers alive", async () => {
    const backend = backendFake();
    vi.mocked(backend.discoverTargets).mockResolvedValue([ANDROID_TARGET]);
    const transport = transportFake();
    const sendH264Packet = vi.mocked(transport.sendH264Packet);
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    await manager.discoverTargets();
    const previewId = (await manager.create(ANDROID_TARGET.targetId)).previewId;
    await manager.startStream({
      streamId: "synced-stream",
      leaseId: "synced-lease",
      previewId,
      format: "h264_annex_b",
    });
    await manager.startStream({
      streamId: "recovering-stream",
      leaseId: "recovering-lease",
      previewId,
      format: "h264_annex_b",
    });
    await backend.emitFrame(h264Configuration());
    await backend.emitFrame(h264Frame(0x65, true));
    await vi.waitFor(() => expect(sendH264Packet).toHaveBeenCalledTimes(4));
    sendH264Packet.mockClear();
    vi.mocked(backend.requestKeyframe).mockRejectedValue(new Error("control socket closed"));

    manager.setFlowPaused("recovering-stream", true, false);
    manager.setFlowPaused("recovering-stream", false, true);

    await vi.waitFor(() =>
      expect(transport.sendComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: "recovering-stream",
          success: false,
          error: "无法恢复 Android 模拟器画面",
        }),
      ),
    );
    expect(manager.hasLease("recovering-lease")).toBe(false);
    expect(manager.hasLease("synced-lease")).toBe(true);
    expect(manager.list().previews[0]).toMatchObject({
      previewId,
      state: "ready",
    });

    await backend.emitFrame(h264Frame(0x41));
    await vi.waitFor(() =>
      expect(sendH264Packet).toHaveBeenCalledWith(
        "synced-stream",
        expect.any(Number),
        expect.objectContaining({ keyframe: false }),
      ),
    );
  });

  it("ignores a stale keyframe request failure after the viewer has already resynchronized", async () => {
    const backend = backendFake();
    vi.mocked(backend.discoverTargets).mockResolvedValue([ANDROID_TARGET]);
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    await manager.discoverTargets();
    const previewId = (await manager.create(ANDROID_TARGET.targetId)).previewId;
    await manager.startStream({
      streamId: "h264-stream",
      leaseId: "h264-lease",
      previewId,
      format: "h264_annex_b",
    });
    await backend.emitFrame(h264Configuration());
    await backend.emitFrame(h264Frame(0x65, true));
    await vi.waitFor(() => expect(transport.sendH264Packet).toHaveBeenCalledTimes(2));

    let rejectRequest!: (error: Error) => void;
    vi.mocked(backend.requestKeyframe).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    manager.setFlowPaused("h264-stream", true, false);
    manager.setFlowPaused("h264-stream", false, true);
    await vi.waitFor(() => expect(backend.requestKeyframe).toHaveBeenCalledTimes(1));

    await backend.emitFrame(h264Configuration(0x68));
    await backend.emitFrame(h264Frame(0x65, true));
    await vi.waitFor(() => expect(transport.sendH264Packet).toHaveBeenCalledTimes(4));
    rejectRequest(new Error("late control socket failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.sendComplete).not.toHaveBeenCalled();
    expect(manager.hasLease("h264-lease")).toBe(true);
    expect(manager.list().previews[0]).toMatchObject({ state: "ready" });
  });

  it("retries a silent Scrcpy reset once, then fails instead of freezing forever", async () => {
    vi.useFakeTimers();
    try {
      const backend = backendFake();
      vi.mocked(backend.discoverTargets).mockResolvedValue([ANDROID_TARGET]);
      const transport = transportFake();
      const manager = new DevicePreviewManager({ backend, streamTransport: transport });
      await manager.discoverTargets();
      const previewId = (await manager.create(ANDROID_TARGET.targetId)).previewId;
      await manager.startStream({
        streamId: "h264-stream",
        leaseId: "h264-lease",
        previewId,
        format: "h264_annex_b",
      });
      await backend.emitFrame(h264Configuration());
      await backend.emitFrame(h264Frame(0x65, true));
      await Promise.resolve();
      await Promise.resolve();

      manager.setFlowPaused("h264-stream", true, false);
      manager.setFlowPaused("h264-stream", false, true);
      await Promise.resolve();
      expect(backend.requestKeyframe).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_500);
      expect(backend.requestKeyframe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_500);

      expect(transport.sendComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: "h264-stream",
          success: false,
          error: "Android 模拟器画面恢复超时",
        }),
      );
      expect(manager.hasLease("h264-lease")).toBe(false);
      expect(manager.list().previews[0]).toMatchObject({ state: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes every viewer but keeps the resource ready after a transient capture failure", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await startJpegStream(manager, "stream-2", "lease-2", previewId);
    const revisionBeforeFailure = manager.list().revision;

    backend.failCapture(new Error("capture unavailable"));
    await vi.waitFor(() => expect(transport.sendComplete).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(backend.discoverTargets).toHaveBeenCalledTimes(2));

    expect(manager.list()).toMatchObject({
      revision: revisionBeforeFailure,
      previews: [{ previewId, state: "ready" }],
    });
    expect(manager.hasLease("lease-1")).toBe(false);
    expect(manager.hasLease("lease-2")).toBe(false);

    await startJpegStream(manager, "stream-3", "lease-3", previewId);
    expect(backend.capture).toHaveBeenCalledTimes(2);
    await backend.emitFrame(frame(3));
    await vi.waitFor(() =>
      expect(transport.sendFrame).toHaveBeenCalledWith(
        "stream-3",
        0,
        expect.objectContaining({ 0: 0xff, 1: 0xd8, 2: 3 }),
      ),
    );

    manager.stopStream("stream-3");
    await manager.shutdown();
  });

  it("marks the resource disconnected only after discovery confirms the target is gone", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const events: unknown[] = [];
    const manager = new DevicePreviewManager({
      backend,
      streamTransport: transport,
      onEvent: (event) => events.push(event),
    });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-offline", "lease-offline", previewId);
    vi.mocked(backend.discoverTargets).mockResolvedValue([]);

    backend.failCapture(new Error("device transport closed"));
    await vi.waitFor(() =>
      expect(manager.list().previews[0]).toMatchObject({ previewId, state: "disconnected" }),
    );

    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "state",
      revision: 2,
      preview: { previewId, state: "disconnected" },
    });
    await expect(
      startJpegStream(manager, "stream-still-offline", "lease-still-offline", previewId),
    ).rejects.toThrow("模拟器没有运行");
    await manager.shutdown();
  });

  it("keeps the resource ready when the post-failure availability probe also fails", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-probe-failure", "lease-probe-failure", previewId);
    vi.mocked(backend.discoverTargets).mockRejectedValueOnce(new Error("simctl unavailable"));

    backend.failCapture(new Error("capture unavailable"));
    await vi.waitFor(() => expect(backend.discoverTargets).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(manager.hasLease("lease-probe-failure")).toBe(false));

    expect(manager.list().previews[0]).toMatchObject({ previewId, state: "ready" });
    await startJpegStream(
      manager,
      "stream-after-probe-failure",
      "lease-after-probe-failure",
      previewId,
    );
    expect(backend.capture).toHaveBeenCalledTimes(2);

    manager.stopStream("stream-after-probe-failure");
    await manager.shutdown();
  });

  it("coalesces availability probes per target and waits for them before backend disposal", async () => {
    const backend = backendFake();
    const transport = transportFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    const previewId = await createPreview(manager);
    let finishProbe!: (targets: DevicePreviewTarget[]) => void;
    vi.mocked(backend.discoverTargets).mockImplementationOnce(
      () =>
        new Promise<DevicePreviewTarget[]>((resolve) => {
          finishProbe = resolve;
        }),
    );
    await startJpegStream(manager, "stream-probe-1", "lease-probe-1", previewId);

    backend.failCapture(new Error("first capture failure"));
    await vi.waitFor(() => expect(backend.discoverTargets).toHaveBeenCalledTimes(2));
    await startJpegStream(manager, "stream-probe-2", "lease-probe-2", previewId);
    backend.failCapture(new Error("second capture failure"));
    await vi.waitFor(() => expect(transport.sendComplete).toHaveBeenCalledTimes(2));
    expect(backend.discoverTargets).toHaveBeenCalledTimes(2);

    const shutdown = manager.shutdown();
    await Promise.resolve();
    expect(backend.dispose).not.toHaveBeenCalled();
    finishProbe([TARGET]);
    await shutdown;
    expect(backend.dispose).toHaveBeenCalledOnce();
  });
});

describe("DevicePreviewManager input lease", () => {
  it("classifies input against an unknown lease as an invalid control lease", async () => {
    const manager = new DevicePreviewManager({
      backend: backendFake(),
      streamTransport: transportFake(),
    });

    await expect(
      manager.sendInput("missing-lease", 1, { kind: "button", button: "home" }),
    ).rejects.toMatchObject({
      message: "设备控制租约已失效",
      errorCode: ControlErrorCode.CONTROL_LEASE_INVALID,
    });
  });

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
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await startJpegStream(manager, "stream-2", "lease-2", previewId);
    const input: DevicePreviewInput = { kind: "button", button: "home" };

    const first = manager.sendInput("lease-1", 7, input);
    const duplicate = manager.sendInput("lease-1", 7, input);
    const secondLease = manager.sendInput("lease-2", 1, { kind: "button", button: "home" });
    await vi.waitFor(() => expect(backend.sendInput).toHaveBeenCalledOnce());
    expect(first).toBe(duplicate);
    expect(backend.sendInput).toHaveBeenCalledWith(TARGET.targetId, input, expect.any(AbortSignal));

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
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await startJpegStream(manager, "stream-2", "lease-2", previewId);

    const first = manager.sendInput("lease-1", 1, { kind: "button", button: "home" });
    const queued = manager.sendInput("lease-2", 1, { kind: "button", button: "back" });
    await vi.waitFor(() => expect(backend.sendInput).toHaveBeenCalledOnce());
    manager.stopStream("stream-2");
    releaseFirst();

    await first;
    await expect(queued).rejects.toThrow("租约已失效");
    expect(backend.sendInput).toHaveBeenCalledTimes(1);
  });

  it("aborts revoked input without resetting the lease's highest input sequence", async () => {
    const backend = backendFake();
    vi.mocked(backend.sendInput)
      .mockImplementationOnce(
        (_targetId, _input, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      )
      .mockResolvedValue(undefined);
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    const running = manager.sendInput("lease-1", 1, { kind: "button", button: "home" });
    const queued = manager.sendInput("lease-1", 2, { kind: "button", button: "back" });
    const oldResults = Promise.allSettled([running, queued]);
    await vi.waitFor(() => expect(backend.sendInput).toHaveBeenCalledOnce());

    manager.revokeInput("lease-1");

    expect(await oldResults).toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
    expect(backend.sendInput).toHaveBeenCalledOnce();
    expect(manager.hasLease("lease-1")).toBe(true);

    // A revoked lease may regain control, but old sequence numbers remain stale for its lifetime.
    await expect(
      manager.sendInput("lease-1", 1, { kind: "button", button: "home" }),
    ).resolves.toBeUndefined();
    expect(backend.sendInput).toHaveBeenCalledOnce();

    await expect(
      manager.sendInput("lease-1", 3, { kind: "button", button: "home" }),
    ).resolves.toBeUndefined();
    expect(backend.sendInput).toHaveBeenCalledTimes(2);
  });

  it("releases an active touch before accepting input after a lease revocation", async () => {
    const backend = backendFake();
    let finishRelease!: () => void;
    vi.mocked(backend.releaseInput).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 0.98,
    });
    manager.revokeInput("lease-1");
    const stale = manager.sendInput("lease-1", 1, { kind: "button", button: "home" });
    const resumed = manager.sendInput("lease-1", 2, { kind: "button", button: "home" });

    await vi.waitFor(() => expect(backend.releaseInput).toHaveBeenCalledWith(TARGET.targetId));
    await expect(stale).resolves.toBeUndefined();
    expect(backend.sendInput).toHaveBeenCalledOnce();
    finishRelease();
    await expect(resumed).resolves.toBeUndefined();
    expect(backend.sendInput).toHaveBeenCalledTimes(2);
    expect(manager.hasLease("lease-1")).toBe(true);
  });

  it("keeps the revoke queue usable when best-effort touch release fails", async () => {
    const backend = backendFake();
    vi.mocked(backend.releaseInput).mockRejectedValueOnce(new Error("release failed"));
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 0.5,
    });

    manager.revokeInput("lease-1");
    await expect(
      manager.sendInput("lease-1", 2, {
        kind: "touch",
        phase: "down",
        x: 0.4,
        y: 0.5,
      }),
    ).resolves.toBeUndefined();

    expect(backend.releaseInput).toHaveBeenCalledOnce();
    expect(vi.mocked(backend.releaseInput).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(backend.sendInput).mock.invocationCallOrder[1]!,
    );
  });

  it("keeps the capture alive until an interrupted last-viewer touch is released", async () => {
    const backend = backendFake();
    let finishRelease!: () => void;
    vi.mocked(backend.releaseInput).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.01,
      y: 0.5,
    });

    manager.stopStream("stream-1");
    await vi.waitFor(() => expect(backend.releaseInput).toHaveBeenCalledOnce());
    expect(backend.captureAborted()).toBe(false);
    expect(backend.releaseTarget).not.toHaveBeenCalled();

    finishRelease();
    await vi.waitFor(() => expect(backend.captureAborted()).toBe(true));
    expect(backend.releaseTarget).toHaveBeenCalledWith(TARGET.targetId);
    expect(vi.mocked(backend.releaseInput).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(backend.releaseTarget).mock.invocationCallOrder[0]!,
    );
  });

  it("does not release another lease's active touch when a view-only peer disconnects", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await startJpegStream(manager, "stream-2", "lease-2", previewId);
    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.01,
      y: 0.5,
    });

    manager.stopStream("stream-2");
    await Promise.resolve();
    expect(backend.releaseInput).not.toHaveBeenCalled();
    await manager.sendInput("lease-1", 2, {
      kind: "touch",
      phase: "up",
      x: 0.4,
      y: 0.5,
    });
    expect(backend.releaseInput).not.toHaveBeenCalled();
  });

  it("tracks one strict down-move-up touch lifecycle at a time", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    const inputs = [
      { kind: "touch", phase: "down", x: 0.3, y: 0.5 },
      { kind: "touch", phase: "move", x: 0.2, y: 0.5 },
      { kind: "touch", phase: "up", x: 0.1, y: 0.5 },
    ] as const;

    for (const [index, input] of inputs.entries()) {
      await manager.sendInput("lease-1", index + 1, input);
    }

    expect(vi.mocked(backend.sendInput).mock.calls.map(([, input]) => input)).toEqual(inputs);
    expect(backend.releaseInput).not.toHaveBeenCalled();

    await manager.sendInput("lease-1", inputs.length + 1, {
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 0.5,
    });
    expect(backend.sendInput).toHaveBeenCalledTimes(inputs.length + 1);
  });

  it("releases an active touch before rotating the target", async () => {
    const backend = backendFake();
    let finishRelease!: () => void;
    vi.mocked(backend.releaseInput).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.3,
      y: 0.5,
    });
    const rotation = manager.sendInput("lease-1", 2, {
      kind: "orientation",
      orientation: "landscape_right",
    });

    await vi.waitFor(() => expect(backend.releaseInput).toHaveBeenCalledOnce());
    expect(backend.releaseInput).toHaveBeenCalledWith(TARGET.targetId);
    expect(backend.sendInput).toHaveBeenCalledOnce();
    finishRelease();
    await rotation;
    expect(vi.mocked(backend.releaseInput).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(backend.sendInput).mock.invocationCallOrder[1]!,
    );
    expect(vi.mocked(backend.sendInput).mock.calls[1]?.[1]).toEqual({
      kind: "orientation",
      orientation: "landscape_right",
    });
    await expect(
      manager.sendInput("lease-1", 3, {
        kind: "touch",
        phase: "move",
        x: 0.2,
        y: 0.5,
      }),
    ).rejects.toThrow("设备触控手势尚未开始");
    await manager.sendInput("lease-1", 4, {
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 0.5,
    });
  });

  it("keeps rotation fail-closed when releasing its active touch fails", async () => {
    const backend = backendFake();
    vi.mocked(backend.releaseInput).mockRejectedValueOnce(new Error("release failed"));
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.3,
      y: 0.5,
    });
    await expect(
      manager.sendInput("lease-1", 2, {
        kind: "orientation",
        orientation: "landscape_right",
      }),
    ).rejects.toThrow("release failed");

    expect(backend.releaseInput).toHaveBeenCalledOnce();
    expect(backend.sendInput).toHaveBeenCalledOnce();
    await expect(
      manager.sendInput("lease-1", 3, {
        kind: "touch",
        phase: "up",
        x: 0.8,
        y: 0.5,
      }),
    ).rejects.toThrow("设备触控手势尚未开始");
  });

  it("rejects a second down without disrupting the active touch", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.3,
      y: 0.5,
    });
    await expect(
      manager.sendInput("lease-1", 2, {
        kind: "touch",
        phase: "down",
        x: 0.5,
        y: 0.5,
      }),
    ).rejects.toThrow("设备触控手势已经开始");

    await manager.sendInput("lease-1", 3, {
      kind: "touch",
      phase: "move",
      x: 0.4,
      y: 0.5,
    });
    await manager.sendInput("lease-1", 4, {
      kind: "touch",
      phase: "up",
      x: 0.4,
      y: 0.5,
    });

    expect(backend.sendInput).toHaveBeenCalledTimes(3);
    expect(backend.releaseInput).not.toHaveBeenCalled();
  });

  it("rejects another lease while a target touch is active", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await startJpegStream(manager, "stream-2", "lease-2", previewId);
    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.3,
      y: 0.5,
    });

    await expect(
      manager.sendInput("lease-2", 1, {
        kind: "touch",
        phase: "down",
        x: 0.7,
        y: 0.5,
      }),
    ).rejects.toThrow("设备正在处理另一条触控手势");
    await expect(
      manager.sendInput("lease-2", 2, {
        kind: "touch",
        phase: "move",
        x: 0.8,
        y: 0.5,
      }),
    ).rejects.toThrow("设备触控手势尚未开始");
    await manager.sendInput("lease-1", 2, {
      kind: "touch",
      phase: "up",
      x: 0.4,
      y: 0.5,
    });

    expect(backend.sendInput).toHaveBeenCalledTimes(2);
  });

  it("rejects move and up phases that have no successful down from the same lease", async () => {
    const backend = backendFake();
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await manager.startStream({
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId,
      format: "jpeg",
    });

    await expect(
      manager.sendInput("lease-1", 1, {
        kind: "touch",
        phase: "move",
        x: 0.2,
        y: 0.5,
      }),
    ).rejects.toThrow("设备触控手势尚未开始");
    await expect(
      manager.sendInput("lease-1", 2, {
        kind: "touch",
        phase: "up",
        x: 0.4,
        y: 0.5,
      }),
    ).rejects.toThrow("设备触控手势尚未开始");
    expect(backend.sendInput).not.toHaveBeenCalled();
  });

  it("best-effort touch cleanup does not hide the original input failure", async () => {
    const backend = backendFake();
    vi.mocked(backend.sendInput).mockRejectedValueOnce(new Error("socket failed"));
    vi.mocked(backend.releaseInput).mockRejectedValueOnce(new Error("cleanup failed"));
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    await expect(
      manager.sendInput("lease-1", 1, {
        kind: "touch",
        phase: "down",
        x: 0.5,
        y: 0.98,
      }),
    ).rejects.toThrow("socket failed");
    expect(backend.releaseInput).toHaveBeenCalledWith(TARGET.targetId);
  });

  it("clears the active touch after a move fails", async () => {
    const backend = backendFake();
    vi.mocked(backend.sendInput).mockImplementation(async (_targetId, input) => {
      if (input.kind === "touch" && input.phase === "move") {
        throw new Error("move failed");
      }
    });
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.3,
      y: 0.5,
    });
    await expect(
      manager.sendInput("lease-1", 2, {
        kind: "touch",
        phase: "move",
        x: 0.2,
        y: 0.5,
      }),
    ).rejects.toThrow("move failed");
    expect(backend.releaseInput).toHaveBeenCalledWith(TARGET.targetId);

    await expect(
      manager.sendInput("lease-1", 3, {
        kind: "touch",
        phase: "move",
        x: 0.8,
        y: 0.5,
      }),
    ).rejects.toThrow("设备触控手势尚未开始");
    await manager.sendInput("lease-1", 4, {
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 0.5,
    });
    expect(backend.sendInput).toHaveBeenCalledTimes(3);
  });

  it("caps pending input per lease before the adapter queue can grow without bound", async () => {
    const backend = backendFake();
    vi.mocked(backend.sendInput).mockImplementation(
      (_targetId, _input, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    const accepted = Array.from({ length: 32 }, (_, index) =>
      manager.sendInput("lease-1", index + 1, { kind: "button", button: "home" }),
    );
    const acceptedResults = Promise.allSettled(accepted);

    await expect(
      manager.sendInput("lease-1", 33, { kind: "button", button: "home" }),
    ).rejects.toMatchObject({
      message: "设备输入队列已满",
      errorCode: ControlErrorCode.RATE_LIMITED,
    });
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
    await startJpegStream(manager, "stream-1", "lease-1", previewId);

    await manager.shutdown();

    expect(backend.captureAborted()).toBe(true);
    expect(backend.dispose).toHaveBeenCalledOnce();
    await expect(
      manager.startStream({ streamId: "x", leaseId: "x", previewId, format: "jpeg" }),
    ).rejects.toThrow("Proxy 正在停止");
  });

  it("releases an active touch before disposing the backend", async () => {
    const backend = backendFake();
    let finishRelease!: () => void;
    vi.mocked(backend.releaseInput).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const manager = new DevicePreviewManager({ backend, streamTransport: transportFake() });
    const previewId = await createPreview(manager);
    await startJpegStream(manager, "stream-1", "lease-1", previewId);
    await manager.sendInput("lease-1", 1, {
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 0.98,
    });

    const shutdown = manager.shutdown();
    await vi.waitFor(() => expect(backend.releaseInput).toHaveBeenCalledOnce());
    expect(backend.dispose).not.toHaveBeenCalled();
    finishRelease();
    await shutdown;

    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(vi.mocked(backend.releaseInput).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(backend.dispose).mock.invocationCallOrder[0]!,
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
      format: "jpeg",
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
