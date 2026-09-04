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
import { AndroidEmulatorAdapter, type AndroidEmulatorInput } from "./android-adapter.js";
import { ScrcpyVideoAdapter } from "./scrcpy-video-adapter.js";
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

interface ActiveAndroidCaptureBinding {
  nativeId: string;
  videoAdapter: ScrcpyVideoAdapter;
  signal: AbortSignal;
}

interface AndroidRuntimeTarget {
  platform: "android";
  nativeId: string;
  adapter: AndroidEmulatorAdapter;
  videoAdapter: ScrcpyVideoAdapter;
}

type RuntimeTarget = IosRuntimeTarget | AndroidRuntimeTarget;

type DevicePlatform = RuntimeTarget["platform"];

interface PlatformDiscoverySnapshot {
  platform: DevicePlatform;
  authoritative: boolean;
  targets: DevicePreviewTarget[];
  runtimeTargets: Map<string, RuntimeTarget>;
}

interface PlatformDiscoveryFailure {
  platform: DevicePlatform;
  error: unknown;
}

type PlatformDiscoveryResult =
  | { status: "fulfilled"; snapshot: PlatformDiscoverySnapshot }
  | { status: "rejected"; failure: PlatformDiscoveryFailure };

interface DefaultDevicePreviewBackendOptions {
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  refreshPath?: typeof refreshLoginShellPath;
  findCandidates?: typeof findExecutableCandidates;
  createAndroidAdapter?: (options: { env: NodeJS.ProcessEnv }) => AndroidEmulatorAdapter;
  createScrcpyVideoAdapter?: (options: {
    adbCommand: string;
    env: NodeJS.ProcessEnv;
  }) => ScrcpyVideoAdapter;
  createIosAdapter?: (options: { command?: string; env: NodeJS.ProcessEnv }) => IosSimulatorAdapter;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function iosFrameRotation(orientation: IosSimulatorOrientation): number {
  switch (orientation) {
    case "landscape-left":
      return 90;
    case "portrait-upside-down":
      return 180;
    case "landscape-right":
      return 270;
    default:
      return 0;
  }
}

async function normalizeJpeg(jpeg: Buffer, signal: AbortSignal, rotation: number): Promise<Buffer> {
  throwIfAborted(signal);
  const normalized = await sharp(jpeg, { limitInputPixels: 32_768 * 32_768 })
    .rotate(rotation)
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
    case "touch":
      return {
        type: "touch",
        phase: input.phase,
        x: input.x,
        y: input.y,
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

type AndroidNonStreamInput = Exclude<DevicePreviewInput, { kind: "text" | "touch" }>;

function toAndroidInput(input: AndroidNonStreamInput): AndroidEmulatorInput {
  switch (input.kind) {
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
  private readonly createAndroidAdapter: NonNullable<
    DefaultDevicePreviewBackendOptions["createAndroidAdapter"]
  >;
  private readonly createIosAdapter: NonNullable<
    DefaultDevicePreviewBackendOptions["createIosAdapter"]
  >;
  private readonly createScrcpyVideoAdapter: NonNullable<
    DefaultDevicePreviewBackendOptions["createScrcpyVideoAdapter"]
  >;
  private readonly iosAdapters = new Set<IosSimulatorAdapter>();
  private readonly retiredIosAdapters = new Set<IosSimulatorAdapter>();
  private readonly iosAdapterActivity = new Map<IosSimulatorAdapter, number>();
  private readonly publishedTargetIosAdapters = new Set<IosSimulatorAdapter>();
  private readonly activeAndroidCaptures = new Map<string, ActiveAndroidCaptureBinding>();
  private readonly activeIosCaptures = new Map<string, ActiveIosCaptureBinding>();
  private readonly runtimeTargets = new Map<string, RuntimeTarget>();
  private readonly publicTargets = new Map<string, DevicePreviewTarget>();
  private androidAdapter?: AndroidEmulatorAdapter;
  private iosAdapter?: IosSimulatorAdapter;
  private baguetteSuggestions: string[] = [];
  private configuredEnv: NodeJS.ProcessEnv = {};
  private configuredPath?: string;
  private configuredBaguetteCommand?: string;
  private configurationVersion = 0;
  private discoveryGeneration = 0;
  private configured = false;
  private configurationQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: DefaultDevicePreviewBackendOptions = {}) {
    this.baseEnv = { ...(options.baseEnv ?? process.env) };
    this.platform = options.platform ?? process.platform;
    this.refreshPath = options.refreshPath ?? refreshLoginShellPath;
    this.findCandidates = options.findCandidates ?? findExecutableCandidates;
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
    this.createScrcpyVideoAdapter =
      options.createScrcpyVideoAdapter ??
      ((adapterOptions) => new ScrcpyVideoAdapter(adapterOptions));
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
    return { ios, android };
  }

  async discoverTargets(refresh = false): Promise<DevicePreviewTarget[]> {
    await this.configure(refresh);
    const configurationVersion = this.configurationVersion;
    const discoveryGeneration = ++this.discoveryGeneration;
    const android = this.androidAdapter!;
    const ios = this.iosAdapter!;
    const configuredEnv = this.configuredEnv;
    const discoveries = [
      this.settlePlatformDiscovery("android", this.discoverAndroidTargets(android, configuredEnv)),
    ];
    if (this.platform === "darwin") {
      discoveries.push(this.settlePlatformDiscovery("ios", this.discoverIosTargets(ios)));
    }
    const results = await Promise.all(discoveries);

    // The request that started last owns publication. An older request may finish after a faster
    // request using the same PATH, or after a PATH refresh replaced its adapters. In both cases it
    // observes the current committed snapshot without mutating either routing table.
    if (
      configurationVersion !== this.configurationVersion ||
      discoveryGeneration !== this.discoveryGeneration
    ) {
      return this.publishedTargetsSnapshot();
    }

    const failures = results
      .filter(
        (result): result is Extract<PlatformDiscoveryResult, { status: "rejected" }> =>
          result.status === "rejected",
      )
      .map((result) => result.failure);
    if (failures.length === results.length) {
      throw new AggregateError(
        failures.map(({ platform, error }) =>
          error instanceof Error
            ? error
            : new Error(`${platform} discovery failed: ${String(error)}`),
        ),
        "无法刷新设备列表",
      );
    }

    const snapshots = new Map<DevicePlatform, PlatformDiscoverySnapshot>();
    for (const result of results) {
      if (result.status === "fulfilled") snapshots.set(result.snapshot.platform, result.snapshot);
    }
    const targets: DevicePreviewTarget[] = [];
    const runtimeTargets = new Map<string, RuntimeTarget>();
    for (const platform of ["android", "ios"] as const) {
      const snapshot = snapshots.get(platform);
      if (snapshot?.authoritative) {
        targets.push(...snapshot.targets);
        for (const [targetId, runtime] of snapshot.runtimeTargets) {
          runtimeTargets.set(targetId, runtime);
        }
        continue;
      }
      // Neither a failed probe nor a temporarily unavailable prerequisite proves that every device
      // on the platform disappeared. Preserve the last complete routing/public snapshot while
      // committing authoritative enumeration results from other platforms.
      for (const target of this.publicTargets.values()) {
        if (target.platform !== platform) continue;
        const runtime = this.runtimeTargets.get(target.targetId);
        if (!runtime) continue;
        targets.push({ ...target });
        runtimeTargets.set(target.targetId, runtime);
      }
    }

    this.publishTargets(runtimeTargets, targets);
    return targets.map((target) => ({ ...target }));
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
      const previousCapture = this.activeAndroidCaptures.get(targetId);
      if (previousCapture && !previousCapture.signal.aborted) {
        throw new Error("该 Android 模拟器画面已在采集中");
      }
      const binding: ActiveAndroidCaptureBinding = {
        nativeId: runtime.nativeId,
        videoAdapter: runtime.videoAdapter,
        signal,
      };
      this.activeAndroidCaptures.set(targetId, binding);
      try {
        await runtime.videoAdapter.stream(runtime.nativeId, signal, async (packet) => {
          await onFrame({
            format: "h264_annex_b",
            ...packet,
          });
        });
      } finally {
        if (this.activeAndroidCaptures.get(targetId) === binding) {
          this.activeAndroidCaptures.delete(targetId);
        }
      }
      return;
    }

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
        const metadata = runtime.adapter.getTargetMetadata(runtime.nativeId);
        const normalized = await normalizeJpeg(
          jpeg,
          signal,
          iosFrameRotation(metadata?.orientation ?? "portrait"),
        );
        await onFrame({
          format: "jpeg",
          jpeg: normalized,
        });
      }
    } finally {
      if (this.activeIosCaptures.get(targetId) === binding) {
        this.activeIosCaptures.delete(targetId);
      }
      this.releaseIosAdapter(runtime.adapter);
    }
  }

  async requestKeyframe(targetId: string): Promise<void> {
    const capture = this.activeAndroidCaptures.get(targetId);
    if (!capture) throw new Error("Android 模拟器画面尚未开始采集");
    await capture.videoAdapter.requestVideoReset(capture.nativeId);
  }

  async sendInput(targetId: string, input: DevicePreviewInput, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const activeIosCapture = this.activeIosCaptures.get(targetId);
    const runtime = activeIosCapture
      ? { platform: "ios" as const, ...activeIosCapture }
      : this.runtimeTargets.get(targetId);
    if (!runtime) throw new Error("模拟器没有运行");
    if (runtime.platform === "android") {
      if (input.kind === "text" || input.kind === "touch") {
        const activeCapture = this.activeAndroidCaptures.get(targetId);
        const videoAdapter = activeCapture?.videoAdapter ?? runtime.videoAdapter;
        const nativeId = activeCapture?.nativeId ?? runtime.nativeId;
        if (input.kind === "text") {
          await videoAdapter.pasteText(nativeId, input.text, signal);
        } else {
          await videoAdapter.sendTouch(
            nativeId,
            {
              phase: input.phase,
              x: input.x,
              y: input.y,
            },
            signal,
          );
        }
        throwIfAborted(signal);
        return;
      }
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

  async releaseInput(targetId: string): Promise<void> {
    const activeAndroidCapture = this.activeAndroidCaptures.get(targetId);
    if (activeAndroidCapture) {
      await activeAndroidCapture.videoAdapter.releaseTouch(activeAndroidCapture.nativeId);
      return;
    }
    const activeIosCapture = this.activeIosCaptures.get(targetId);
    const runtime = activeIosCapture
      ? { platform: "ios" as const, ...activeIosCapture }
      : this.runtimeTargets.get(targetId);
    if (runtime?.platform === "android") {
      await runtime.videoAdapter.releaseTouch(runtime.nativeId);
      return;
    }
    if (runtime?.platform === "ios") {
      this.retainIosAdapter(runtime.adapter);
      try {
        await runtime.adapter.releaseTouch(runtime.nativeId);
      } finally {
        this.releaseIosAdapter(runtime.adapter);
      }
      return;
    }

    const nativeId = targetId.startsWith("ios:") ? targetId.slice("ios:".length) : undefined;
    if (!nativeId) return;
    const adapters = [...this.iosAdapters];
    for (const adapter of adapters) this.retainIosAdapter(adapter);
    try {
      const results = await Promise.allSettled(
        adapters.map((adapter) => adapter.releaseTouch(nativeId)),
      );
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
    } finally {
      for (const adapter of adapters) this.releaseIosAdapter(adapter);
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
      // important when capability detection and target refresh arrive concurrently: the older
      // inherited PATH must never replace an adapter built from the refreshed login-shell PATH.
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
      const androidAdapter = this.createAndroidAdapter({ env });
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
      this.configuredEnv = env;
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
    const adb = await adapter.inspect();
    if (!adb.available || !adb.command) {
      return {
        supported: true,
        available: false,
        interactive: false,
        ...(adb.command ? { command: adb.command } : {}),
        ...(adb.version ? { version: adb.version.slice(0, 256) } : {}),
        error: adb.error ?? "未找到 Android Debug Bridge (adb)",
      };
    }
    const scrcpy = await this.createConfiguredScrcpyVideoAdapter(adb.command).inspect();
    if (!scrcpy.available) {
      return {
        supported: true,
        available: false,
        interactive: false,
        command: adb.command,
        ...(adb.version ? { version: adb.version.slice(0, 256) } : {}),
        error: "Android 模拟器预览组件缺失，请重新安装 DEV Anywhere",
      };
    }
    return {
      supported: true,
      available: true,
      interactive: true,
      command: adb.command,
      ...(adb.version ? { version: adb.version.slice(0, 256) } : {}),
    };
  }

  private createConfiguredScrcpyVideoAdapter(adbCommand: string): ScrcpyVideoAdapter {
    return this.createScrcpyVideoAdapter({
      adbCommand,
      env: this.configuredEnv,
    });
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
    if (!capability.available || !capability.command) {
      return {
        supported: true,
        available: false,
        interactive: false,
        ...(capability.command ? { command: capability.command } : {}),
        ...(capability.version ? { version: capability.version } : {}),
        ...(baguetteSuggestions.length > 0 ? { suggestions: baguetteSuggestions } : {}),
        error: unavailableError,
      };
    }
    return {
      supported: true,
      available: true,
      interactive: true,
      command: capability.command,
      ...(capability.version ? { version: capability.version } : {}),
      ...(baguetteSuggestions.length > 0 ? { suggestions: baguetteSuggestions } : {}),
    };
  }

  private async settlePlatformDiscovery(
    platform: DevicePlatform,
    discovery: Promise<PlatformDiscoverySnapshot>,
  ): Promise<PlatformDiscoveryResult> {
    try {
      return { status: "fulfilled", snapshot: await discovery };
    } catch (error) {
      serviceLogger.warn(
        { platform, error: String(error) },
        platform === "android"
          ? "Android Emulator discovery failed"
          : "iOS Simulator discovery failed",
      );
      return { status: "rejected", failure: { platform, error } };
    }
  }

  private async discoverAndroidTargets(
    adapter: AndroidEmulatorAdapter,
    env: NodeJS.ProcessEnv,
  ): Promise<PlatformDiscoverySnapshot> {
    const targets: DevicePreviewTarget[] = [];
    const runtimeTargets = new Map<string, RuntimeTarget>();
    const capability = await adapter.inspect();
    if (!capability.available || !capability.command) {
      return { platform: "android", authoritative: false, targets, runtimeTargets };
    }
    const videoAdapter = this.createScrcpyVideoAdapter({
      adbCommand: capability.command,
      env,
    });
    const videoCapability = await videoAdapter.inspect();
    if (!videoCapability.available) {
      return { platform: "android", authoritative: false, targets, runtimeTargets };
    }
    for (const device of await adapter.discover()) {
      if (device.width > 16_384 || device.height > 16_384) continue;
      const targetId = `android:${device.serial}`;
      targets.push({
        targetId,
        platform: "android",
        name: device.model.slice(0, 256),
        model: device.model.slice(0, 256),
        osVersion: device.release.slice(0, 256),
        width: device.width,
        height: device.height,
        interactive: true,
      });
      runtimeTargets.set(targetId, {
        platform: "android",
        nativeId: device.serial,
        adapter,
        videoAdapter,
      });
    }
    return { platform: "android", authoritative: true, targets, runtimeTargets };
  }

  private async discoverIosTargets(
    adapter: IosSimulatorAdapter,
  ): Promise<PlatformDiscoverySnapshot> {
    const targets: DevicePreviewTarget[] = [];
    const runtimeTargets = new Map<string, RuntimeTarget>();
    this.retainIosAdapter(adapter);
    try {
      if (!(await adapter.inspectBaguetteCapability()).available) {
        return { platform: "ios", authoritative: false, targets, runtimeTargets };
      }
      const devices = await adapter.discoverDevices();
      for (const device of devices) {
        if (!device.booted) continue;
        const osVersion = iosVersion(device.runtimeIdentifier);
        if (!osVersion) continue;
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
        const target = {
          targetId,
          platform: "ios" as const,
          name: device.name.slice(0, 256),
          model: device.model.slice(0, 256),
          osVersion,
          interactive,
        };
        targets.push(
          width !== undefined && height !== undefined ? { ...target, width, height } : target,
        );
        runtimeTargets.set(targetId, {
          platform: "ios",
          nativeId: device.udid,
          adapter,
        });
      }
      return { platform: "ios", authoritative: true, targets, runtimeTargets };
    } finally {
      this.releaseIosAdapter(adapter);
    }
  }

  private publishedTargetsSnapshot(): DevicePreviewTarget[] {
    return [...this.publicTargets.values()].map((target) => ({ ...target }));
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
