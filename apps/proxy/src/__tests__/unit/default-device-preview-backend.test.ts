import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { DefaultDevicePreviewBackend } from "#src/serve/device-preview/default-device-preview-backend.js";
import { DevicePreviewManager } from "#src/serve/device-preview/device-preview-manager.js";
import type { AndroidEmulatorAdapter } from "#src/serve/device-preview/android-adapter.js";
import type { IosSimulatorAdapter } from "#src/serve/device-preview/ios-adapter.js";
import type { ScrcpyVideoAdapter } from "#src/serve/device-preview/scrcpy-video-adapter.js";
import type {
  DevicePreviewJpegFrame,
  DevicePreviewStreamTransport,
} from "#src/serve/device-preview/types.js";

const IOS_UDID = "8A9E7E48-71B5-48C1-BD3F-E29CDBDC7A21";

function androidAdapterFake() {
  return {
    inspect: vi.fn(async () => ({
      available: true,
      command: "/sdk/platform-tools/adb",
      version: "Android Debug Bridge version 1.0.41",
    })),
    discover: vi.fn(async () => [
      {
        platform: "android" as const,
        serial: "emulator-5554",
        model: "Pixel 9 Pro",
        apiLevel: 35,
        release: "15",
        width: 1080,
        height: 2400,
        rotation: 0 as const,
      },
    ]),
    getDevice: vi.fn(),
    sendInput: vi.fn(async () => undefined),
  } as unknown as AndroidEmulatorAdapter;
}

function iosAdapterFake() {
  return {
    inspectBaguetteCapability: vi.fn(async () => ({
      available: true,
      command: "/tools/baguette",
      version: "0.1.97",
    })),
    discoverDevices: vi.fn(async () => [
      {
        platform: "ios" as const,
        udid: IOS_UDID,
        name: "iPhone 17 Pro",
        model: "iPhone 17 Pro",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        rawState: "Booted",
        state: "booted" as const,
        booted: true,
        interactive: true,
        logicalPointSize: { width: 402, height: 874 },
        orientation: "portrait" as const,
      },
      {
        platform: "ios" as const,
        udid: "117F8F48-A899-469B-A544-8B1D7DF8AB31",
        name: "iPhone Air",
        model: "iPhone Air",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        rawState: "Shutdown",
        state: "shutdown" as const,
        booted: false,
        interactive: false,
      },
    ]),
    getTargetMetadata: vi.fn(() => ({
      udid: IOS_UDID,
      logicalPointSize: { width: 402, height: 874 },
      orientation: "portrait" as const,
    })),
    streamMjpeg: vi.fn(),
    sendInput: vi.fn(async () => undefined),
    releaseTouch: vi.fn(async () => undefined),
    closeInput: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IosSimulatorAdapter;
}

function scrcpyVideoAdapterFake() {
  return {
    inspect: vi.fn(async () => ({
      available: true,
      version: "4.1",
      serverPath: "/package/assets/scrcpy/scrcpy-server-v4.1",
    })),
    stream: vi.fn(),
    requestVideoReset: vi.fn(async () => undefined),
    pasteText: vi.fn(async () => undefined),
    sendTouch: vi.fn(async () => undefined),
    releaseTouch: vi.fn(async () => undefined),
  } as unknown as ScrcpyVideoAdapter;
}

describe("DefaultDevicePreviewBackend", () => {
  it("fails closed when the bundled Android preview component is missing", async () => {
    const android = androidAdapterFake();
    const scrcpy = scrcpyVideoAdapterFake();
    vi.mocked(scrcpy.inspect).mockResolvedValue({
      available: false,
      error: "The bundled Android preview component is unavailable",
    });
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpy,
      createIosAdapter: () => iosAdapterFake(),
    });

    await expect(backend.inspectCapabilities()).resolves.toMatchObject({
      android: {
        supported: true,
        available: false,
        interactive: false,
        command: "/sdk/platform-tools/adb",
        version: "Android Debug Bridge version 1.0.41",
        error: "Android 模拟器预览组件缺失，请重新安装 DEV Anywhere",
      },
    });
    await expect(backend.discoverTargets()).resolves.toEqual([]);
    expect(android.discover).not.toHaveBeenCalled();
  });

  it("returns only currently running Android and Booted iOS targets", async () => {
    const android = androidAdapterFake();
    const ios = iosAdapterFake();
    const findCandidates = vi.fn((name: string) =>
      name === "baguette" ? ["/tools/baguette"] : [],
    );
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      baseEnv: { PATH: "/tools:/sdk/platform-tools" },
      findCandidates,
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpyVideoAdapterFake(),
      createIosAdapter: () => ios,
    });

    await expect(backend.discoverTargets()).resolves.toEqual([
      {
        targetId: "android:emulator-5554",
        platform: "android",
        name: "Pixel 9 Pro",
        model: "Pixel 9 Pro",
        osVersion: "15",
        width: 1080,
        height: 2400,
        interactive: true,
      },
      {
        targetId: `ios:${IOS_UDID}`,
        platform: "ios",
        name: "iPhone 17 Pro",
        model: "iPhone 17 Pro",
        osVersion: "26.5",
        width: 402,
        height: 874,
        interactive: true,
      },
    ]);
    expect(ios.discoverDevices).toHaveBeenCalledOnce();
    expect(findCandidates).toHaveBeenCalledWith("baguette", expect.any(Object));
    expect(findCandidates).not.toHaveBeenCalledWith("scrcpy", expect.anything());
  });

  it("preserves the last Android snapshot when only Android discovery fails", async () => {
    const android = androidAdapterFake();
    const ios = iosAdapterFake();
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpyVideoAdapterFake(),
      createIosAdapter: () => ios,
    });
    await backend.discoverTargets();
    vi.mocked(android.discover).mockRejectedValueOnce(new Error("adb server unavailable"));
    vi.mocked(ios.discoverDevices).mockResolvedValueOnce([]);

    await expect(backend.discoverTargets()).resolves.toEqual([
      expect.objectContaining({
        targetId: "android:emulator-5554",
        name: "Pixel 9 Pro",
      }),
    ]);

    await backend.sendInput(
      "android:emulator-5554",
      { kind: "orientation", orientation: "auto" },
      new AbortController().signal,
    );
    expect(android.sendInput).toHaveBeenCalledWith("emulator-5554", { type: "free" });
  });

  it("rejects a fully failed discovery without discarding published routes", async () => {
    const android = androidAdapterFake();
    const ios = iosAdapterFake();
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpyVideoAdapterFake(),
      createIosAdapter: () => ios,
    });
    await backend.discoverTargets();
    vi.mocked(android.discover).mockRejectedValueOnce(new Error("adb server unavailable"));
    vi.mocked(ios.discoverDevices).mockRejectedValueOnce(new Error("simctl unavailable"));

    await expect(backend.discoverTargets()).rejects.toThrow("无法刷新设备列表");

    const signal = new AbortController().signal;
    await backend.sendInput(
      "android:emulator-5554",
      { kind: "orientation", orientation: "auto" },
      signal,
    );
    await backend.sendInput(`ios:${IOS_UDID}`, { kind: "button", button: "home" }, signal);
    expect(android.sendInput).toHaveBeenCalledWith("emulator-5554", { type: "free" });
    expect(ios.sendInput).toHaveBeenCalledWith(IOS_UDID, { type: "home" }, { signal });
  });

  it("keeps an active preview while its video component is unavailable but disconnects after an empty enumeration", async () => {
    const android = androidAdapterFake();
    const scrcpy = scrcpyVideoAdapterFake();
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    let captureAborted = false;
    vi.mocked(scrcpy.stream).mockImplementation(async (_serial, signal) => {
      markStreamStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          captureAborted = true;
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            captureAborted = true;
            resolve();
          },
          { once: true },
        );
      });
    });
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpy,
      createIosAdapter: () => iosAdapterFake(),
    });
    const transport: DevicePreviewStreamTransport = {
      sendFrame: vi.fn(),
      sendH264Packet: vi.fn(),
      sendComplete: vi.fn(),
    };
    const manager = new DevicePreviewManager({ backend, streamTransport: transport });
    await manager.discoverTargets();
    const preview = await manager.create("android:emulator-5554");
    await manager.startStream({
      streamId: "stream-1",
      leaseId: "lease-1",
      previewId: preview.previewId,
      format: "h264_annex_b",
    });
    await streamStarted;
    vi.mocked(scrcpy.inspect).mockResolvedValueOnce({
      available: false,
      error: "Android video component temporarily unavailable",
    });

    await expect(manager.discoverTargets()).resolves.toEqual([
      expect.objectContaining({ targetId: "android:emulator-5554" }),
    ]);
    expect(manager.list().previews).toEqual([
      expect.objectContaining({ previewId: preview.previewId, state: "ready" }),
    ]);
    expect(captureAborted).toBe(false);
    expect(transport.sendComplete).not.toHaveBeenCalled();

    vi.mocked(android.discover).mockResolvedValueOnce([]);
    await expect(manager.discoverTargets()).resolves.toEqual([]);
    await vi.waitFor(() => expect(captureAborted).toBe(true));
    expect(manager.list().previews).toEqual([
      expect.objectContaining({ previewId: preview.previewId, state: "disconnected" }),
    ]);
    expect(transport.sendComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "stream-1",
        success: false,
        error: "设备已离线",
      }),
    );
    await manager.shutdown();
  });

  it("captures Android through Scrcpy H.264", async () => {
    const android = androidAdapterFake();
    const scrcpy = scrcpyVideoAdapterFake();
    vi.mocked(scrcpy.stream).mockImplementation(async (_serial, _signal, onPacket) => {
      await onPacket({
        kind: "frame",
        keyframe: true,
        durationMs: 33,
        data: Buffer.from([0, 0, 0, 1, 0x65]),
      });
    });
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpy,
      createIosAdapter: () => iosAdapterFake(),
    });
    await backend.discoverTargets();
    const onFrame = vi.fn();

    await backend.capture("android:emulator-5554", new AbortController().signal, onFrame);

    expect(scrcpy.stream).toHaveBeenCalledWith(
      "emulator-5554",
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "h264_annex_b",
        kind: "frame",
        keyframe: true,
      }),
    );
  });

  it("requests a keyframe from the Scrcpy capture that owns the Android target", async () => {
    const android = androidAdapterFake();
    const scrcpy = scrcpyVideoAdapterFake();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.mocked(scrcpy.stream).mockImplementation(async (_serial, signal) => {
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpy,
      createIosAdapter: () => iosAdapterFake(),
    });
    await backend.discoverTargets();

    await expect(backend.requestKeyframe("android:emulator-5554")).rejects.toThrow("尚未开始采集");
    const abort = new AbortController();
    const capture = backend.capture("android:emulator-5554", abort.signal, vi.fn());
    await started;

    await backend.requestKeyframe("android:emulator-5554");
    expect(scrcpy.requestVideoReset).toHaveBeenCalledWith("emulator-5554");

    abort.abort();
    await capture;
    await expect(backend.requestKeyframe("android:emulator-5554")).rejects.toThrow("尚未开始采集");
  });

  it("hands an aborted Android capture over without waiting for Scrcpy cleanup", async () => {
    const android = androidAdapterFake();
    const scrcpy = scrcpyVideoAdapterFake();
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let finishFirstCleanup!: () => void;
    const firstCleanup = new Promise<void>((resolve) => {
      finishFirstCleanup = resolve;
    });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    let streamCall = 0;
    vi.mocked(scrcpy.stream).mockImplementation(async (_serial, signal) => {
      streamCall += 1;
      if (streamCall === 1) {
        markFirstStarted();
        await firstCleanup;
        return;
      }
      markSecondStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpy,
      createIosAdapter: () => iosAdapterFake(),
    });
    await backend.discoverTargets();

    const firstAbort = new AbortController();
    const firstCapture = backend.capture("android:emulator-5554", firstAbort.signal, vi.fn());
    await firstStarted;
    firstAbort.abort();

    const secondAbort = new AbortController();
    const secondCapture = backend.capture("android:emulator-5554", secondAbort.signal, vi.fn());
    await secondStarted;
    expect(scrcpy.stream).toHaveBeenCalledTimes(2);
    await backend.requestKeyframe("android:emulator-5554");
    expect(scrcpy.requestVideoReset).toHaveBeenCalledWith("emulator-5554");

    secondAbort.abort();
    await secondCapture;
    finishFirstCleanup();
    await firstCapture;
  });

  it("keeps an iOS target view-only when Baguette layout has no logical point size", async () => {
    const ios = iosAdapterFake();
    vi.mocked(ios.discoverDevices).mockResolvedValueOnce([
      {
        platform: "ios",
        udid: IOS_UDID,
        name: "iPhone 17 Pro",
        model: "iPhone 17 Pro",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        rawState: "Booted",
        state: "booted",
        booted: true,
        interactive: false,
      },
    ]);
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => androidAdapterFake(),
      createIosAdapter: () => ios,
    });

    const targets = await backend.discoverTargets();
    expect(targets.find((target) => target.platform === "ios")).toMatchObject({
      targetId: `ios:${IOS_UDID}`,
      interactive: false,
    });
  });

  it("rotates iOS frames and publishes live dimensions from the requested orientation", async () => {
    const ios = iosAdapterFake();
    const portraitJpeg = await sharp({
      create: { width: 40, height: 80, channels: 3, background: "#4477aa" },
    })
      .jpeg()
      .toBuffer();
    vi.mocked(ios.getTargetMetadata).mockReturnValue({
      udid: IOS_UDID,
      logicalPointSize: { width: 874, height: 402 },
      orientation: "landscape-left",
    });
    vi.mocked(ios.streamMjpeg).mockImplementation(async function* () {
      yield portraitJpeg;
    });
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => androidAdapterFake(),
      createScrcpyVideoAdapter: () => scrcpyVideoAdapterFake(),
      createIosAdapter: () => ios,
    });
    await backend.discoverTargets();
    let received: DevicePreviewJpegFrame | undefined;

    await backend.capture(`ios:${IOS_UDID}`, new AbortController().signal, (frame) => {
      if (frame.format !== "h264_annex_b") received = frame;
    });

    expect(received).toMatchObject({ format: "jpeg" });
    expect(await sharp(received!.jpeg).metadata()).toMatchObject({ width: 80, height: 40 });
  });

  it("asks the user to upgrade when Baguette predates the safe serve implementation", async () => {
    const ios = iosAdapterFake();
    vi.mocked(ios.inspectBaguetteCapability).mockResolvedValue({
      available: false,
      command: "/tools/baguette",
      version: "0.1.95",
      reason: "unsupported_version",
    });
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => androidAdapterFake(),
      createIosAdapter: () => ios,
    });

    await expect(backend.inspectCapabilities()).resolves.toMatchObject({
      ios: {
        supported: true,
        available: false,
        interactive: false,
        version: "0.1.95",
        error: "Baguette 版本过低，请升级到 0.1.96 或更高版本",
      },
    });
  });

  it("maps shared input onto platform adapters without any simulator lifecycle commands", async () => {
    const android = androidAdapterFake();
    const scrcpy = scrcpyVideoAdapterFake();
    const ios = iosAdapterFake();
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpy,
      createIosAdapter: () => ios,
    });
    await backend.discoverTargets();
    const androidInputAbort = new AbortController();

    await backend.sendInput(
      "android:emulator-5554",
      {
        kind: "orientation",
        orientation: "auto",
      },
      androidInputAbort.signal,
    );
    await backend.sendInput(
      "android:emulator-5554",
      {
        kind: "text",
        text: "你好 👋🏽",
      },
      androidInputAbort.signal,
    );
    await backend.sendInput(
      `ios:${IOS_UDID}`,
      { kind: "text", text: "你好" },
      androidInputAbort.signal,
    );
    await backend.sendInput(
      `ios:${IOS_UDID}`,
      {
        kind: "touch",
        phase: "move",
        x: 0.5,
        y: 0.6,
      },
      androidInputAbort.signal,
    );

    expect(android.sendInput).toHaveBeenCalledWith("emulator-5554", { type: "free" });
    expect(scrcpy.pasteText).toHaveBeenCalledWith(
      "emulator-5554",
      "你好 👋🏽",
      androidInputAbort.signal,
    );
    expect(ios.sendInput).toHaveBeenCalledWith(
      IOS_UDID,
      { type: "text", text: "你好" },
      { signal: androidInputAbort.signal },
    );
    expect(ios.sendInput).toHaveBeenCalledWith(
      IOS_UDID,
      { type: "touch", phase: "move", x: 0.5, y: 0.6 },
      { signal: androidInputAbort.signal },
    );
    await backend.sendInput(
      "android:emulator-5554",
      {
        kind: "touch",
        phase: "down",
        x: 0.5,
        y: 0.9,
      },
      androidInputAbort.signal,
    );
    expect(scrcpy.sendTouch).toHaveBeenCalledWith(
      "emulator-5554",
      {
        phase: "down",
        x: 0.5,
        y: 0.9,
      },
      androidInputAbort.signal,
    );
    expect(android.sendInput).toHaveBeenCalledOnce();

    await backend.releaseInput(`ios:${IOS_UDID}`);
    await backend.releaseInput("android:emulator-5554");
    expect(ios.releaseTouch).toHaveBeenCalledOnce();
    expect(ios.releaseTouch).toHaveBeenCalledWith(IOS_UDID);
    expect(scrcpy.releaseTouch).toHaveBeenCalledOnce();
    expect(scrcpy.releaseTouch).toHaveBeenCalledWith("emulator-5554");

    backend.releaseTarget(`ios:${IOS_UDID}`);
    expect(ios.closeInput).toHaveBeenCalledWith(IOS_UDID);
    expect(ios.dispose).not.toHaveBeenCalled();
  });

  it("serializes concurrent configuration and keeps the refreshed login-shell PATH", async () => {
    const oldAndroid = androidAdapterFake();
    const freshAndroid = androidAdapterFake();
    const createdWithPaths: Array<string | undefined> = [];
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let finishRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      baseEnv: { PATH: "/inherited" },
      refreshPath: vi.fn(async () => {
        releaseRefresh();
        await refreshBlocked;
        return { source: "login-shell" as const, path: "/login-shell" };
      }),
      createAndroidAdapter: ({ env }) => {
        createdWithPaths.push(env.PATH);
        return env.PATH === "/login-shell" ? freshAndroid : oldAndroid;
      },
      createScrcpyVideoAdapter: () => scrcpyVideoAdapterFake(),
      createIosAdapter: () => iosAdapterFake(),
    });

    const refreshedTargets = backend.discoverTargets(true);
    await refreshStarted;
    const concurrentCapability = backend.inspectCapabilities(false);
    finishRefresh();
    await Promise.all([refreshedTargets, concurrentCapability]);
    await backend.discoverTargets(false);

    expect(createdWithPaths).toEqual(["/login-shell"]);
    expect(freshAndroid.discover).toHaveBeenCalledTimes(2);
    expect(oldAndroid.inspect).not.toHaveBeenCalled();
  });

  it("finishes on the refreshed adapter when capability and target requests start together", async () => {
    const inheritedAndroid = androidAdapterFake();
    const refreshedAndroid = androidAdapterFake();
    const createdWithPaths: Array<string | undefined> = [];
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      baseEnv: { PATH: "/inherited" },
      refreshPath: vi.fn(async () => ({
        source: "login-shell" as const,
        path: "/login-shell",
      })),
      createAndroidAdapter: ({ env }) => {
        createdWithPaths.push(env.PATH);
        return env.PATH === "/login-shell" ? refreshedAndroid : inheritedAndroid;
      },
      createScrcpyVideoAdapter: () => scrcpyVideoAdapterFake(),
      createIosAdapter: () => iosAdapterFake(),
    });

    await Promise.all([backend.inspectCapabilities(false), backend.discoverTargets(true)]);
    await backend.discoverTargets(false);

    expect(createdWithPaths).toEqual(["/inherited", "/login-shell"]);
    expect(refreshedAndroid.discover).toHaveBeenCalledTimes(2);
    expect(inheritedAndroid.discover).not.toHaveBeenCalled();
  });

  it("reuses the iOS adapter when a PATH refresh resolves to the same configuration", async () => {
    const ios = iosAdapterFake();
    const createIosAdapter = vi.fn(() => ios);
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      baseEnv: { PATH: "/tools" },
      refreshPath: vi.fn(async () => ({ source: "login-shell" as const, path: "/tools" })),
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => androidAdapterFake(),
      createIosAdapter,
    });

    await backend.discoverTargets();
    await backend.discoverTargets(true);

    expect(createIosAdapter).toHaveBeenCalledOnce();
    expect(ios.dispose).not.toHaveBeenCalled();
    await backend.dispose();
    expect(ios.dispose).toHaveBeenCalledOnce();
  });

  it("keeps a replaced iOS adapter alive until captures and its published routes are gone", async () => {
    const oldIos = iosAdapterFake();
    const freshIos = iosAdapterFake();
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    vi.mocked(oldIos.streamMjpeg).mockImplementation(async function* ({ signal }) {
      markStreamStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      if (!signal?.aborted) yield Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    });
    const createIosAdapter = vi
      .fn<(options: { command?: string; env: NodeJS.ProcessEnv }) => IosSimulatorAdapter>()
      .mockReturnValueOnce(oldIos)
      .mockReturnValueOnce(freshIos);
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      baseEnv: { PATH: "/old" },
      refreshPath: vi.fn(async () => ({ source: "login-shell" as const, path: "/fresh" })),
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => androidAdapterFake(),
      createIosAdapter,
    });
    await backend.discoverTargets();
    const abort = new AbortController();
    const capture = backend.capture(`ios:${IOS_UDID}`, abort.signal, vi.fn());
    await streamStarted;
    await expect(
      backend.capture(`ios:${IOS_UDID}`, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("已在采集中");

    await backend.inspectCapabilities(true);
    await backend.discoverTargets();
    expect(oldIos.dispose).not.toHaveBeenCalled();

    // Target discovery now publishes the fresh adapter, but input must stay on the adapter that
    // owns the live capture WebSocket until that capture exits.
    const inputSignal = new AbortController().signal;
    await backend.sendInput(`ios:${IOS_UDID}`, { kind: "button", button: "home" }, inputSignal);
    expect(oldIos.sendInput).toHaveBeenCalledWith(
      IOS_UDID,
      { type: "home" },
      { signal: inputSignal },
    );
    expect(freshIos.sendInput).not.toHaveBeenCalled();
    abort.abort();
    await capture;

    expect(oldIos.dispose).toHaveBeenCalledOnce();
    expect(freshIos.dispose).not.toHaveBeenCalled();
    await backend.dispose();
    expect(freshIos.dispose).toHaveBeenCalledOnce();
  });

  it("keeps the published iOS route when a refreshed Baguette is unavailable", async () => {
    const oldIos = iosAdapterFake();
    const freshIos = iosAdapterFake();
    vi.mocked(freshIos.inspectBaguetteCapability).mockResolvedValue({
      available: false,
      reason: "not_found",
    });
    const createIosAdapter = vi
      .fn<(options: { command?: string; env: NodeJS.ProcessEnv }) => IosSimulatorAdapter>()
      .mockReturnValueOnce(oldIos)
      .mockReturnValueOnce(freshIos);
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      baseEnv: { PATH: "/old" },
      refreshPath: vi.fn(async () => ({ source: "login-shell" as const, path: "/fresh" })),
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => androidAdapterFake(),
      createScrcpyVideoAdapter: () => scrcpyVideoAdapterFake(),
      createIosAdapter,
    });
    await backend.discoverTargets();

    await expect(backend.discoverTargets(true)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ targetId: `ios:${IOS_UDID}` })]),
    );
    const signal = new AbortController().signal;
    await backend.sendInput(`ios:${IOS_UDID}`, { kind: "button", button: "home" }, signal);

    expect(oldIos.sendInput).toHaveBeenCalledWith(IOS_UDID, { type: "home" }, { signal });
    expect(freshIos.sendInput).not.toHaveBeenCalled();
    expect(oldIos.dispose).not.toHaveBeenCalled();
    await backend.dispose();
    expect(oldIos.dispose).toHaveBeenCalledOnce();
    expect(freshIos.dispose).toHaveBeenCalledOnce();
  });

  it("never publishes a slow discovery result from a retired configuration", async () => {
    const oldIos = iosAdapterFake();
    const freshIos = iosAdapterFake();
    let markOldDiscoveryStarted!: () => void;
    const oldDiscoveryStarted = new Promise<void>((resolve) => {
      markOldDiscoveryStarted = resolve;
    });
    let finishOldDiscovery!: () => void;
    const oldDiscoveryBlocked = new Promise<void>((resolve) => {
      finishOldDiscovery = resolve;
    });
    const oldDevices = await oldIos.discoverDevices();
    vi.mocked(oldIos.discoverDevices).mockClear();
    vi.mocked(oldIos.discoverDevices).mockImplementationOnce(async () => {
      markOldDiscoveryStarted();
      await oldDiscoveryBlocked;
      return oldDevices;
    });
    vi.mocked(freshIos.discoverDevices).mockResolvedValue(
      oldDevices.map((device) =>
        device.udid === IOS_UDID ? { ...device, name: "Fresh iPhone" } : device,
      ),
    );
    const createIosAdapter = vi
      .fn<(options: { command?: string; env: NodeJS.ProcessEnv }) => IosSimulatorAdapter>()
      .mockReturnValueOnce(oldIos)
      .mockReturnValueOnce(freshIos);
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      baseEnv: { PATH: "/old" },
      refreshPath: vi.fn(async () => ({ source: "login-shell" as const, path: "/fresh" })),
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => androidAdapterFake(),
      createIosAdapter,
    });

    const slowOldTargets = backend.discoverTargets();
    await oldDiscoveryStarted;
    await expect(backend.discoverTargets(true)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Fresh iPhone" })]),
    );
    finishOldDiscovery();
    await expect(slowOldTargets).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Fresh iPhone" })]),
    );

    await backend.sendInput(
      `ios:${IOS_UDID}`,
      { kind: "button", button: "home" },
      new AbortController().signal,
    );
    expect(freshIos.sendInput).toHaveBeenCalledOnce();
    expect(oldIos.sendInput).not.toHaveBeenCalled();
    expect(oldIos.dispose).toHaveBeenCalledOnce();
    await backend.dispose();
  });

  it("never publishes a slow older discovery from the same configuration", async () => {
    const android = androidAdapterFake();
    const originalDevice = (await android.discover())[0]!;
    vi.mocked(android.discover).mockClear();
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    let finishSlow!: () => void;
    const slowBlocked = new Promise<void>((resolve) => {
      finishSlow = resolve;
    });
    vi.mocked(android.discover)
      .mockImplementationOnce(async () => {
        markSlowStarted();
        await slowBlocked;
        return [{ ...originalDevice, model: "Slow stale Pixel" }];
      })
      .mockResolvedValue([{ ...originalDevice, model: "Fast current Pixel" }]);
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      createAndroidAdapter: () => android,
      createScrcpyVideoAdapter: () => scrcpyVideoAdapterFake(),
      createIosAdapter: () => iosAdapterFake(),
    });

    const slowTargets = backend.discoverTargets();
    await slowStarted;
    await expect(backend.discoverTargets()).resolves.toEqual([
      expect.objectContaining({ name: "Fast current Pixel" }),
    ]);
    finishSlow();

    await expect(slowTargets).resolves.toEqual([
      expect.objectContaining({ name: "Fast current Pixel" }),
    ]);
  });
});
