import type {
  DevicePreviewCapability,
  DevicePreviewInput,
  DevicePreviewTarget,
  DevicePreviewToolStatus,
} from "@dev-anywhere/shared";
import sharp from "sharp";
import { refreshLoginShellPath } from "../../common/login-shell-path.js";
import { serviceLogger } from "../../common/logger.js";
import { findExecutableCandidates } from "../../providers/path-resolver.js";
import {
  AndroidEmulatorAdapter,
  type AndroidEmulatorInput,
  type AndroidPngToJpegEncoder,
} from "./android-adapter.js";
import {
  IosSimulatorAdapter,
  type IosSimulatorInput,
  type IosSimulatorOrientation,
} from "./ios-adapter.js";
import type { DevicePreviewBackend, DevicePreviewFrame } from "./types.js";

const FRAME_WIDTH = 720;
const FRAME_QUALITY = 70;

interface IosRuntimeTarget {
  platform: "ios";
  nativeId: string;
  adapter: IosSimulatorAdapter;
}

interface ActiveIosCaptureBinding {
  nativeId: string;
  adapter: IosSimulatorAdapter;
}

interface AndroidRuntimeTarget {
  platform: "android";
  nativeId: string;
  adapter: AndroidEmulatorAdapter;
}

type RuntimeTarget = IosRuntimeTarget | AndroidRuntimeTarget;

export interface DefaultDevicePreviewBackendOptions {
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  refreshPath?: typeof refreshLoginShellPath;
  findCandidates?: typeof findExecutableCandidates;
  encodePngToJpeg?: AndroidPngToJpegEncoder;
  createAndroidAdapter?: (options: {
    env: NodeJS.ProcessEnv;
    encodePngToJpeg: AndroidPngToJpegEncoder;
  }) => AndroidEmulatorAdapter;
  createIosAdapter?: (options: { command?: string; env: NodeJS.ProcessEnv }) => IosSimulatorAdapter;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

const defaultPngToJpeg: AndroidPngToJpegEncoder = async (png, options) => {
  throwIfAborted(options.signal);
  const jpeg = await sharp(png, { limitInputPixels: 32_768 * 32_768 })
    .rotate()
    .resize({ width: options.width, withoutEnlargement: true })
    .jpeg({ quality: options.quality })
    .toBuffer();
  throwIfAborted(options.signal);
  return jpeg;
};

async function normalizeJpeg(jpeg: Buffer, signal: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal);
  const normalized = await sharp(jpeg, { limitInputPixels: 32_768 * 32_768 })
    .rotate()
    .resize({ width: FRAME_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: FRAME_QUALITY })
    .toBuffer();
  throwIfAborted(signal);
  return normalized;
}

function iosVersion(runtimeIdentifier: string): string | undefined {
  const match = /\.iOS-([0-9-]+)$/u.exec(runtimeIdentifier);
  return match?.[1]?.replaceAll("-", ".");
}

function iosOrientation(
  orientation: DevicePreviewInput & { kind: "orientation" },
): IosSimulatorOrientation {
  switch (orientation.orientation) {
    case "portrait":
      return "portrait";
    case "portrait_upside_down":
      return "portrait-upside-down";
    case "landscape_left":
      return "landscape-left";
    case "landscape_right":
      return "landscape-right";
    case "auto":
      throw new Error("iOS 模拟器不支持自动旋转");
  }
}

function toIosInput(input: DevicePreviewInput): IosSimulatorInput {
  switch (input.kind) {
    case "tap":
      return { type: "tap", x: input.x, y: input.y };
    case "swipe":
      return {
        type: "swipe",
        startX: input.startX,
        startY: input.startY,
        endX: input.endX,
        endY: input.endY,
        durationMs: input.durationMs,
      };
    case "text":
      return { type: "text", text: input.text };
    case "button":
      if (input.button === "back") throw new Error("iOS 模拟器没有返回键");
      return { type: "home" };
    case "orientation":
      return { type: "orientation", orientation: iosOrientation(input) };
  }
}

function toAndroidInput(input: DevicePreviewInput): AndroidEmulatorInput {
  switch (input.kind) {
    case "tap":
      return { type: "tap", x: input.x, y: input.y };
    case "swipe":
      return {
        type: "swipe",
        from: { x: input.startX, y: input.startY },
        to: { x: input.endX, y: input.endY },
        durationMs: input.durationMs,
      };
    case "text":
      return { type: "text", text: input.text };
    case "button":
      return { type: input.button };
    case "orientation":
      switch (input.orientation) {
        case "portrait":
          return { type: "rotate", rotation: 0 };
        case "landscape_left":
          return { type: "rotate", rotation: 90 };
        case "portrait_upside_down":
          return { type: "rotate", rotation: 180 };
        case "landscape_right":
          return { type: "rotate", rotation: 270 };
        case "auto":
          return { type: "free" };
      }
  }
}

export class DefaultDevicePreviewBackend implements DevicePreviewBackend {
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly refreshPath: typeof refreshLoginShellPath;
  private readonly findCandidates: typeof findExecutableCandidates;
  private readonly encodePngToJpeg: AndroidPngToJpegEncoder;
  private readonly createAndroidAdapter: NonNullable<
    DefaultDevicePreviewBackendOptions["createAndroidAdapter"]
  >;
  private readonly createIosAdapter: NonNullable<
    DefaultDevicePreviewBackendOptions["createIosAdapter"]
  >;
  private readonly iosAdapters = new Set<IosSimulatorAdapter>();
  private readonly retiredIosAdapters = new Set<IosSimulatorAdapter>();
  private readonly iosAdapterActivity = new Map<IosSimulatorAdapter, number>();
  private readonly publishedTargetIosAdapters = new Set<IosSimulatorAdapter>();
  private readonly activeIosCaptures = new Map<string, ActiveIosCaptureBinding>();
  private readonly runtimeTargets = new Map<string, RuntimeTarget>();
  private readonly publicTargets = new Map<string, DevicePreviewTarget>();
  private androidAdapter?: AndroidEmulatorAdapter;
  private iosAdapter?: IosSimulatorAdapter;
  private baguetteSuggestions: string[] = [];
  private configuredPath?: string;
  private configuredBaguetteCommand?: string;
  private configurationVersion = 0;
  private configured = false;
  private configurationQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: DefaultDevicePreviewBackendOptions = {}) {
    this.baseEnv = { ...(options.baseEnv ?? process.env) };
    this.platform = options.platform ?? process.platform;
    this.refreshPath = options.refreshPath ?? refreshLoginShellPath;
    this.findCandidates = options.findCandidates ?? findExecutableCandidates;
    this.encodePngToJpeg = options.encodePngToJpeg ?? defaultPngToJpeg;
    this.createAndroidAdapter =
      options.createAndroidAdapter ??
      ((adapterOptions) => new AndroidEmulatorAdapter(adapterOptions));
    this.createIosAdapter =
      options.createIosAdapter ??
      ((adapterOptions) =>
        new IosSimulatorAdapter({
          baguetteCommand: adapterOptions.command,
          baguetteEnv: adapterOptions.env,
          simctlEnv: adapterOptions.env,
        }));
  }

  async inspectCapabilities(refreshPath = false): Promise<DevicePreviewCapability> {
    await this.configure(refreshPath);
    const configurationVersion = this.configurationVersion;
    const androidAdapter = this.androidAdapter!;
    const iosAdapter = this.iosAdapter!;
    const baguetteSuggestions = [...this.baguetteSuggestions];
    this.retainIosAdapter(iosAdapter);
    let android: DevicePreviewToolStatus;
    let ios: DevicePreviewToolStatus;
    try {
      android = await this.androidCapability(androidAdapter);
      ios = await this.iosCapability(iosAdapter, baguetteSuggestions);
    } finally {
      this.releaseIosAdapter(iosAdapter);
    }
    // A refresh can replace the adapters while the tool probes above are still running. Do not
    // return a mixed or already-retired capability snapshot to the caller.
    if (configurationVersion !== this.configurationVersion) {
      return this.inspectCapabilities(false);
    }
    return { supported: ios.supported || android.supported, ios, android };
  }

  async discoverTargets(refresh = false): Promise<DevicePreviewTarget[]> {
    await this.configure(refresh);
    const configurationVersion = this.configurationVersion;
    const targets: DevicePreviewTarget[] = [];
    const runtimeTargets = new Map<string, RuntimeTarget>();

    const android = this.androidAdapter;
    if (android) {
      try {
        const capability = await android.inspect();
        if (capability.available) {
          for (const device of await android.discover()) {
            if (device.width > 16_384 || device.height > 16_384) continue;
            const targetId = `android:${device.serial}`;
            targets.push({
              targetId,
              platform: "android",
              name: device.model.slice(0, 256),
              osVersion: device.release.slice(0, 256),
              runtime: `API ${device.apiLevel}`,
              state: "booted",
              width: device.width,
              height: device.height,
              interactive: true,
            });
            runtimeTargets.set(targetId, {
              platform: "android",
              nativeId: device.serial,
              adapter: android,
            });
          }
        }
      } catch (error) {
        serviceLogger.warn({ error: String(error) }, "Android Emulator discovery failed");
      }
    }

    const ios = this.iosAdapter;
    if (ios) this.retainIosAdapter(ios);
    try {
      if (this.platform === "darwin" && ios && (await ios.inspectBaguetteCapability()).available) {
        try {
          const devices = await ios.discoverDevices();
          for (const device of devices) {
            if (!device.booted) continue;
            let width: number | undefined;
            let height: number | undefined;
            let interactive = false;
            if (device.logicalPointSize) {
              width = device.logicalPointSize.width;
              height = device.logicalPointSize.height;
              interactive = true;
            } else {
              serviceLogger.warn(
                { udid: device.udid },
                "iOS Simulator layout unavailable; target is view-only",
              );
            }

            const targetId = `ios:${device.udid}`;
            targets.push({
              targetId,
              platform: "ios",
              name: device.name.slice(0, 256),
              ...(iosVersion(device.runtimeIdentifier)
                ? { osVersion: iosVersion(device.runtimeIdentifier) }
                : {}),
              runtime: device.runtimeIdentifier.slice(0, 256),
              state: "booted",
              ...(width ? { width } : {}),
              ...(height ? { height } : {}),
              interactive,
            });
            runtimeTargets.set(targetId, {
              platform: "ios",
              nativeId: device.udid,
              adapter: ios,
            });
          }
        } catch (error) {
          serviceLogger.warn({ error: String(error) }, "iOS Simulator discovery failed");
        }
      }
    } finally {
      if (ios) this.releaseIosAdapter(ios);
    }

    // A slower discovery from an old configuration must never overwrite targets published by a
    // newer login-shell PATH refresh. Retry against the already-published current configuration.
    if (configurationVersion !== this.configurationVersion) {
      return this.discoverTargets(false);
    }

    this.publishTargets(runtimeTargets, targets);
    return targets;
  }

  /*
   * Keep target discovery above as one atomic configuration snapshot. The iOS adapter is retained
   * for the complete probe so a concurrent PATH refresh cannot dispose it from underneath xcrun.
   */

  async capture(
    targetId: string,
    signal: AbortSignal,
    onFrame: (frame: DevicePreviewFrame) => void | Promise<void>,
  ): Promise<void> {
    const runtime = this.runtimeTargets.get(targetId);
    if (!runtime) throw new Error("模拟器没有运行");
    if (runtime.platform === "android") {
      await runtime.adapter.streamFrames(
        runtime.nativeId,
        async (jpeg) => {
          const device = runtime.adapter.getDevice(runtime.nativeId);
          if (!device) throw new Error("Android Emulator 已断开");
          await onFrame({ jpeg, width: device.width, height: device.height });
        },
        { signal },
      );
      return;
    }

    const target = this.targetMetadata(targetId);
    if (this.activeIosCaptures.has(targetId)) {
      throw new Error("该 iOS 模拟器画面已在采集中");
    }
    const binding: ActiveIosCaptureBinding = {
      nativeId: runtime.nativeId,
      adapter: runtime.adapter,
    };
    this.retainIosAdapter(runtime.adapter);
    this.activeIosCaptures.set(targetId, binding);
    try {
      for await (const jpeg of runtime.adapter.streamMjpeg({ udid: runtime.nativeId, signal })) {
        const normalized = await normalizeJpeg(jpeg, signal);
        await onFrame({
          jpeg: normalized,
          width: target.width ?? FRAME_WIDTH,
          height: target.height ?? FRAME_WIDTH,
        });
      }
    } finally {
      if (this.activeIosCaptures.get(targetId) === binding) {
        this.activeIosCaptures.delete(targetId);
      }
      this.releaseIosAdapter(runtime.adapter);
    }
  }

  async sendInput(
    targetId: string,
    input: DevicePreviewInput,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const activeIosCapture = this.activeIosCaptures.get(targetId);
    const runtime = activeIosCapture
      ? { platform: "ios" as const, ...activeIosCapture }
      : this.runtimeTargets.get(targetId);
    if (!runtime) throw new Error("模拟器没有运行");
    if (runtime.platform === "android") {
      await runtime.adapter.sendInput(runtime.nativeId, toAndroidInput(input));
      throwIfAborted(signal);
      return;
    }
    this.retainIosAdapter(runtime.adapter);
    try {
      await runtime.adapter.sendInput(runtime.nativeId, toIosInput(input), { signal });
    } finally {
      this.releaseIosAdapter(runtime.adapter);
    }
  }

  releaseTarget(targetId: string): void {
    const runtime = this.runtimeTargets.get(targetId);
    const nativeId =
      runtime?.platform === "ios"
        ? runtime.nativeId
        : targetId.startsWith("ios:")
          ? targetId.slice("ios:".length)
          : undefined;
    // Discovery intentionally publishes only live devices. Fall back to the namespaced target ID
    // so a device that just went offline can still have its persistent helper closed.
    if (!nativeId) return;
    for (const adapter of this.iosAdapters) {
      try {
        adapter.closeInput(nativeId);
      } catch (error) {
        serviceLogger.warn(
          { targetId, error: String(error) },
          "Could not release iOS Simulator input helper",
        );
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.configurationQueue;
    for (const adapter of this.publishedTargetIosAdapters) this.releaseIosAdapter(adapter);
    this.publishedTargetIosAdapters.clear();
    for (const adapter of this.iosAdapters) this.disposeIosAdapter(adapter);
    this.iosAdapters.clear();
    this.retiredIosAdapters.clear();
    this.iosAdapterActivity.clear();
    this.activeIosCaptures.clear();
    this.runtimeTargets.clear();
    this.publicTargets.clear();
  }

  private async configure(refreshPath: boolean): Promise<void> {
    if (this.disposed) throw new Error("设备预览 Backend 已停止");
    const operation = this.configurationQueue.then(async () => {
      // A non-refreshing request queued behind any completed configuration must reuse it. This is
      // important when proxy_info and target refresh arrive concurrently: the older inherited PATH
      // must never replace an adapter built from the user's refreshed login-shell PATH.
      if (this.configured && !refreshPath) return;

      const env = { ...this.baseEnv };
      if (refreshPath) {
        const refreshed = await this.refreshPath({ env });
        if (refreshed.path === undefined) delete env.PATH;
        else env.PATH = refreshed.path;
      }

      // Build the next configuration into locals, then publish it atomically. If refresh or adapter
      // construction fails, active captures keep using the last complete configuration.
      const baguetteSuggestions = this.findCandidates("baguette", env)
        .filter((candidate) => candidate.length > 0 && candidate.length <= 4_096)
        .slice(0, 32);
      const baguetteCommand = baguetteSuggestions[0];
      const androidAdapter = this.createAndroidAdapter({
        env,
        encodePngToJpeg: this.encodePngToJpeg,
      });
      const previousIosAdapter = this.iosAdapter;
      const canReuseIosAdapter =
        this.configured &&
        previousIosAdapter !== undefined &&
        this.configuredPath === env.PATH &&
        this.configuredBaguetteCommand === baguetteCommand;
      const iosAdapter = canReuseIosAdapter
        ? previousIosAdapter
        : this.createIosAdapter({ command: baguetteCommand, env });

      this.androidAdapter = androidAdapter;
      this.baguetteSuggestions = baguetteSuggestions;
      this.iosAdapter = iosAdapter;
      this.configuredPath = env.PATH;
      this.configuredBaguetteCommand = baguetteCommand;
      this.iosAdapters.add(iosAdapter);
      this.configured = true;
      this.configurationVersion += 1;
      if (previousIosAdapter && previousIosAdapter !== iosAdapter) {
        this.retireIosAdapter(previousIosAdapter);
      }
    });
    // A failed refresh is observable by its caller but must not poison later configuration attempts.
    this.configurationQueue = operation.catch(() => undefined);
    return operation;
  }

  private async androidCapability(
    adapter: AndroidEmulatorAdapter,
  ): Promise<DevicePreviewToolStatus> {
    const capability = await adapter.inspect();
    return {
      supported: true,
      available: capability.available,
      interactive: capability.available,
      ...(capability.command ? { command: capability.command } : {}),
      ...(capability.version ? { version: capability.version.slice(0, 256) } : {}),
      ...(!capability.available
        ? { error: capability.error ?? "未找到 Android Debug Bridge (adb)" }
        : {}),
    };
  }

  private async iosCapability(
    adapter: IosSimulatorAdapter,
    baguetteSuggestions: string[],
  ): Promise<DevicePreviewToolStatus> {
    if (this.platform !== "darwin") {
      return {
        supported: false,
        available: false,
        interactive: false,
        error: "iOS 模拟器仅支持 macOS 开发机",
      };
    }
    const capability = await adapter.inspectBaguetteCapability();
    const unavailableError =
      capability.reason === "unsupported_version"
        ? "Baguette 版本过低，请升级到 0.1.96 或更高版本"
        : "未找到 Baguette";
    return {
      supported: true,
      available: capability.available,
      interactive: capability.available,
      ...(capability.command ? { command: capability.command } : {}),
      ...(capability.version ? { version: capability.version } : {}),
      ...(baguetteSuggestions.length > 0 ? { suggestions: baguetteSuggestions } : {}),
      ...(!capability.available ? { error: unavailableError } : {}),
    };
  }

  private targetMetadata(targetId: string): DevicePreviewTarget {
    const target = this.publicTargets.get(targetId);
    if (!target) throw new Error("模拟器没有运行");
    return target;
  }

  private publishTargets(
    runtimeTargets: Map<string, RuntimeTarget>,
    targets: DevicePreviewTarget[],
  ): void {
    if (this.disposed) throw new Error("设备预览 Backend 已停止");
    const nextIosAdapters = new Set<IosSimulatorAdapter>();
    for (const runtime of runtimeTargets.values()) {
      if (runtime.platform === "ios") nextIosAdapters.add(runtime.adapter);
    }

    // runtimeTargets itself is a live routing table. Hold every adapter referenced by the next
    // table before publishing it, swap both maps synchronously, then release the old table's
    // holds. A concurrent PATH refresh can therefore retire an adapter, but cannot dispose it in
    // the window where capture/input still route through the previous table.
    for (const adapter of nextIosAdapters) this.retainIosAdapter(adapter);
    const previousIosAdapters = [...this.publishedTargetIosAdapters];
    this.runtimeTargets.clear();
    for (const [targetId, runtime] of runtimeTargets) this.runtimeTargets.set(targetId, runtime);
    this.publicTargets.clear();
    for (const target of targets) this.publicTargets.set(target.targetId, { ...target });
    this.publishedTargetIosAdapters.clear();
    for (const adapter of nextIosAdapters) this.publishedTargetIosAdapters.add(adapter);
    for (const adapter of previousIosAdapters) this.releaseIosAdapter(adapter);
  }

  private retainIosAdapter(adapter: IosSimulatorAdapter): void {
    this.iosAdapterActivity.set(adapter, (this.iosAdapterActivity.get(adapter) ?? 0) + 1);
  }

  private releaseIosAdapter(adapter: IosSimulatorAdapter): void {
    const remaining = (this.iosAdapterActivity.get(adapter) ?? 1) - 1;
    if (remaining > 0) {
      this.iosAdapterActivity.set(adapter, remaining);
      return;
    }
    this.iosAdapterActivity.delete(adapter);
    if (this.retiredIosAdapters.has(adapter)) this.finalizeRetiredIosAdapter(adapter);
  }

  private retireIosAdapter(adapter: IosSimulatorAdapter): void {
    this.retiredIosAdapters.add(adapter);
    if (!this.iosAdapterActivity.has(adapter)) this.finalizeRetiredIosAdapter(adapter);
  }

  private finalizeRetiredIosAdapter(adapter: IosSimulatorAdapter): void {
    this.retiredIosAdapters.delete(adapter);
    this.iosAdapters.delete(adapter);
    this.disposeIosAdapter(adapter);
  }

  private disposeIosAdapter(adapter: IosSimulatorAdapter): void {
    try {
      adapter.dispose();
    } catch (error) {
      serviceLogger.warn({ error: String(error) }, "Could not dispose iOS Simulator adapter");
    }
  }
}
