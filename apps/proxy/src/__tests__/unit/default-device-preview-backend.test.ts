import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { DefaultDevicePreviewBackend } from "#src/serve/device-preview/default-device-preview-backend.js";
import type {
  AndroidEmulatorAdapter,
  AndroidPngToJpegEncoder,
} from "#src/serve/device-preview/android-adapter.js";
import type { IosSimulatorAdapter } from "#src/serve/device-preview/ios-adapter.js";

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
    streamFrames: vi.fn(),
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
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        rawState: "Shutdown",
        state: "shutdown" as const,
        booted: false,
        interactive: false,
      },
    ]),
    streamMjpeg: vi.fn(),
    sendInput: vi.fn(async () => undefined),
    closeInput: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IosSimulatorAdapter;
}

describe("DefaultDevicePreviewBackend", () => {
  it("returns only currently running Android and Booted iOS targets", async () => {
    const android = androidAdapterFake();
    const ios = iosAdapterFake();
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      baseEnv: { PATH: "/tools:/sdk/platform-tools" },
      findCandidates: vi.fn((name) => (name === "baguette" ? ["/tools/baguette"] : [])),
      createAndroidAdapter: () => android,
      createIosAdapter: () => ios,
    });

    await expect(backend.discoverTargets()).resolves.toEqual([
      {
        targetId: "android:emulator-5554",
        platform: "android",
        name: "Pixel 9 Pro",
        osVersion: "15",
        runtime: "API 35",
        state: "booted",
        width: 1080,
        height: 2400,
        interactive: true,
      },
      {
        targetId: `ios:${IOS_UDID}`,
        platform: "ios",
        name: "iPhone 17 Pro",
        osVersion: "26.5",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        state: "booted",
        width: 402,
        height: 874,
        interactive: true,
      },
    ]);
    expect(ios.discoverDevices).toHaveBeenCalledOnce();
  });

  it("keeps an iOS target view-only when Baguette layout has no logical point size", async () => {
    const ios = iosAdapterFake();
    vi.mocked(ios.discoverDevices).mockResolvedValueOnce([
      {
        platform: "ios",
        udid: IOS_UDID,
        name: "iPhone 17 Pro",
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
      state: "booted",
    });
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
    const ios = iosAdapterFake();
    const backend = new DefaultDevicePreviewBackend({
      platform: "darwin",
      findCandidates: vi.fn(() => ["/tools/baguette"]),
      createAndroidAdapter: () => android,
      createIosAdapter: () => ios,
    });
    await backend.discoverTargets();

    await backend.sendInput("android:emulator-5554", {
      kind: "orientation",
      orientation: "auto",
    });
    await backend.sendInput(`ios:${IOS_UDID}`, { kind: "text", text: "你好" });

    expect(android.sendInput).toHaveBeenCalledWith("emulator-5554", { type: "free" });
    expect(ios.sendInput).toHaveBeenCalledWith(
      IOS_UDID,
      { type: "text", text: "你好" },
      { signal: undefined },
    );

    backend.releaseTarget(`ios:${IOS_UDID}`);
    expect(ios.closeInput).toHaveBeenCalledWith(IOS_UDID);
    expect(ios.dispose).not.toHaveBeenCalled();
  });

  it("uses a real PNG-to-JPEG encoder capped to 720px at quality 70", async () => {
    let encoder: AndroidPngToJpegEncoder | undefined;
    const backend = new DefaultDevicePreviewBackend({
      platform: "linux",
      createAndroidAdapter: (options) => {
        encoder = options.encodePngToJpeg;
        return androidAdapterFake();
      },
      createIosAdapter: () => iosAdapterFake(),
    });
    await backend.inspectCapabilities();
    const png = await sharp({
      create: { width: 1_000, height: 2_000, channels: 3, background: "#4477aa" },
    })
      .png()
      .toBuffer();

    const jpeg = await encoder!(png, {
      width: 720,
      quality: 70,
      signal: new AbortController().signal,
    });
    const metadata = await sharp(jpeg).metadata();

    expect(metadata).toMatchObject({ format: "jpeg", width: 720, height: 1440 });
    await backend.dispose();
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
    await backend.sendInput(`ios:${IOS_UDID}`, { kind: "button", button: "home" });
    expect(oldIos.sendInput).toHaveBeenCalledWith(
      IOS_UDID,
      { type: "home" },
      { signal: undefined },
    );
    expect(freshIos.sendInput).not.toHaveBeenCalled();
    abort.abort();
    await capture;

    expect(oldIos.dispose).toHaveBeenCalledOnce();
    expect(freshIos.dispose).not.toHaveBeenCalled();
    await backend.dispose();
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

    await backend.sendInput(`ios:${IOS_UDID}`, { kind: "button", button: "home" });
    expect(freshIos.sendInput).toHaveBeenCalledOnce();
    expect(oldIos.sendInput).not.toHaveBeenCalled();
    expect(oldIos.dispose).toHaveBeenCalledOnce();
    await backend.dispose();
  });
});
