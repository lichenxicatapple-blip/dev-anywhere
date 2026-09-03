import {
  ControlErrorCode,
  DEVICE_PREVIEW_FRAME_MAX_BYTES,
  type ControlErrorCode as ControlErrorCodeType,
  type DevicePreviewCapability,
  type DevicePreviewInput,
  type DevicePreviewStreamFormat,
  type DevicePreviewSummary,
  type DevicePreviewTarget,
} from "@dev-anywhere/shared";
import { nanoid } from "nanoid";
import { serviceLogger } from "../../common/logger.js";
import {
  normalizeOptionalPreviewName,
  normalizeRequiredPreviewName,
} from "../preview/preview-name.js";
import type {
  DevicePreviewBackend,
  DevicePreviewH264Packet,
  DevicePreviewJpegFrame,
  DevicePreviewManagerEvent,
  DevicePreviewSnapshot,
  DevicePreviewStreamStarted,
  DevicePreviewStreamStart,
  DevicePreviewStreamTransport,
} from "./types.js";

const MAX_DEVICE_PREVIEWS = 16;
const MAX_DEVICE_VIEWERS = 8;
const INPUT_RESULT_CACHE_SIZE = 64;
const MAX_OUTSTANDING_INPUTS_PER_LEASE = 32;
const DEFAULT_MAX_FPS = 15;
const MIN_MAX_FPS = 1;
const MAX_MAX_FPS = 30;
const MAX_H264_QUEUE_PACKETS = 4;
const H264_KEYFRAME_REQUEST_COOLDOWN_MS = 500;
const H264_KEYFRAME_RESPONSE_TIMEOUT_MS = 2_500;
const MAX_H264_KEYFRAME_REQUEST_ATTEMPTS = 2;
const MAX_PUBLIC_ERROR_LENGTH = 1_024;

interface PreviewRecord {
  summary: DevicePreviewSummary;
}

interface Viewer {
  streamId: string;
  leaseId: string;
  previewId: string;
  targetId: string;
  format: DevicePreviewStreamFormat;
  maxFps: number;
  paused: boolean;
  stopped: boolean;
  sending: boolean;
  frameSequence: number;
  lastSentAt: number;
  pendingFrame?: DevicePreviewJpegFrame;
  h264Queue: DevicePreviewH264Packet[];
  needsKeyframe: boolean;
  sendTimer?: NodeJS.Timeout;
  inputAbort: AbortController;
}

interface CaptureGroup {
  targetId: string;
  viewers: Set<string>;
  abort: AbortController;
  task: Promise<void>;
  latestFrame?: DevicePreviewJpegFrame;
  h264Configuration?: DevicePreviewH264Packet;
  keyframeRequestInFlight: boolean;
  keyframeRequestGeneration: number;
  lastKeyframeRequestAt: number;
  keyframeRequestAttempts: number;
  keyframeRequestTimer?: NodeJS.Timeout;
  keyframeResponseTimer?: NodeJS.Timeout;
}

interface PendingStreamStart {
  streamId: string;
  leaseId: string;
  previewId: string;
  cancelled: boolean;
  promise?: Promise<DevicePreviewStreamStarted>;
}

interface LeaseInputState {
  highestSequence: number;
  results: Map<number, Promise<void>>;
  pendingSequences: Set<number>;
}

interface ActiveTouchState {
  leaseId: string;
}

interface TargetDiscovery {
  generation: number;
  promise: Promise<DevicePreviewTarget[]>;
}

interface DevicePreviewManagerOptions {
  backend: DevicePreviewBackend;
  streamTransport: DevicePreviewStreamTransport;
  onEvent?: (event: DevicePreviewManagerEvent) => void;
  now?: () => number;
}

export class DevicePreviewOperationError extends Error {
  constructor(
    message: string,
    readonly errorCode: ControlErrorCodeType = ControlErrorCode.UNKNOWN,
  ) {
    super(message);
    this.name = "DevicePreviewOperationError";
  }
}

function publicError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return (value.trim() || "设备预览发生错误").slice(0, MAX_PUBLIC_ERROR_LENGTH);
}

function cloneTarget(target: DevicePreviewTarget): DevicePreviewTarget {
  return { ...target };
}

function cloneSummary(summary: DevicePreviewSummary): DevicePreviewSummary {
  return { ...summary };
}

function boundedMaxFps(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FPS;
  if (!Number.isFinite(value)) return DEFAULT_MAX_FPS;
  return Math.max(MIN_MAX_FPS, Math.min(MAX_MAX_FPS, Math.floor(value)));
}

function validateInputSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new DevicePreviewOperationError("无效的设备输入序号");
  }
}

function expectedFormat(platform: DevicePreviewTarget["platform"]): DevicePreviewStreamFormat {
  return platform === "android" ? "h264_annex_b" : "jpeg";
}

function validateStreamProfile(
  input: DevicePreviewStreamStart,
  platform: DevicePreviewTarget["platform"],
): DevicePreviewStreamFormat {
  const expected = expectedFormat(platform);
  const format = input.format;
  if (format !== expected) {
    throw new DevicePreviewOperationError(
      platform === "android" ? "Android 模拟器画面仅支持 H.264" : "iOS 模拟器画面仅支持 JPEG",
    );
  }
  return format;
}

export class DevicePreviewManager {
  readonly epoch = nanoid();
  private revision = 0;
  private readonly backend: DevicePreviewBackend;
  private readonly streamTransport: DevicePreviewStreamTransport;
  private readonly onEvent?: (event: DevicePreviewManagerEvent) => void;
  private readonly now: () => number;
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly targets = new Map<string, DevicePreviewTarget>();
  private readonly pendingStarts = new Map<string, PendingStreamStart>();
  private readonly viewers = new Map<string, Viewer>();
  private readonly leaseViewers = new Map<string, Viewer>();
  private readonly captures = new Map<string, CaptureGroup>();
  private readonly targetAvailabilityProbes = new Map<string, Promise<void>>();
  private readonly leaseInputs = new Map<string, LeaseInputState>();
  private readonly targetInputQueues = new Map<string, Promise<void>>();
  private readonly activeTouches = new Map<string, ActiveTouchState>();
  private readonly pendingTargetReleases = new Set<string>();
  private discoveryGeneration = 0;
  private latestDiscovery?: TargetDiscovery;
  private shuttingDown = false;
  private shutdownTask?: Promise<void>;

  constructor(options: DevicePreviewManagerOptions) {
    this.backend = options.backend;
    this.streamTransport = options.streamTransport;
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
  }

  inspectCapabilities(refreshPath = false): Promise<DevicePreviewCapability> {
    this.assertRunning();
    return this.backend.inspectCapabilities(refreshPath);
  }

  discoverTargets(refresh = false): Promise<DevicePreviewTarget[]> {
    this.assertRunning();
    const generation = ++this.discoveryGeneration;
    const promise = this.runTargetDiscovery(generation, refresh);
    this.latestDiscovery = { generation, promise };
    return promise;
  }

  private async runTargetDiscovery(
    generation: number,
    refresh: boolean,
  ): Promise<DevicePreviewTarget[]> {
    let targets: DevicePreviewTarget[];
    try {
      targets = await this.backend.discoverTargets(refresh);
    } catch (error) {
      this.assertRunning();
      if (generation !== this.discoveryGeneration) return this.awaitLatestDiscovery(generation);
      throw error;
    }
    this.assertRunning();
    if (generation !== this.discoveryGeneration) return this.awaitLatestDiscovery(generation);
    this.targets.clear();
    for (const target of targets) this.targets.set(target.targetId, cloneTarget(target));

    for (const record of this.previews.values()) {
      const target = this.targets.get(record.summary.targetId);
      if (target) {
        this.updateTargetMetadata(record, target);
        if (record.summary.state === "disconnected") this.updateState(record, "ready");
      } else if (record.summary.state !== "disconnected") {
        this.stopPreviewViewers(record.summary.previewId, "设备已离线", true);
        this.releaseTargetIfIdle(record.summary.targetId);
        this.updateState(record, "disconnected");
      }
    }
    return targets.map(cloneTarget);
  }

  private awaitLatestDiscovery(completedGeneration: number): Promise<DevicePreviewTarget[]> {
    const latest = this.latestDiscovery;
    if (!latest || latest.generation <= completedGeneration) {
      throw new Error("设备发现代次异常");
    }
    return latest.promise;
  }

  list(): DevicePreviewSnapshot {
    return {
      epoch: this.epoch,
      revision: this.revision,
      previews: [...this.previews.values()]
        .map((record) => cloneSummary(record.summary))
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  create(targetId: string, name?: string): Promise<DevicePreviewSummary> {
    this.assertRunning();
    const customName = this.normalizeOptionalName(name);
    return this.createOnce(targetId, customName).then(cloneSummary);
  }

  private async createOnce(
    targetId: string,
    customName: string | undefined,
  ): Promise<DevicePreviewSummary> {
    let target = this.targets.get(targetId);
    if (!target) {
      await this.discoverTargets(true);
      target = this.targets.get(targetId);
    }
    if (!target) throw new DevicePreviewOperationError("没有找到正在运行的模拟器");

    const existingTarget = [...this.previews.values()].find(
      (record) => record.summary.targetId === targetId,
    );
    if (existingTarget) return cloneSummary(existingTarget.summary);
    if (this.previews.size >= MAX_DEVICE_PREVIEWS) {
      throw new DevicePreviewOperationError(
        `最多可保留 ${MAX_DEVICE_PREVIEWS} 个设备预览`,
        ControlErrorCode.RATE_LIMITED,
      );
    }

    const timestamp = this.now();
    const summary: DevicePreviewSummary = {
      previewId: nanoid(),
      name: customName ?? target.name,
      platform: target.platform,
      targetId: target.targetId,
      model: target.model,
      osVersion: target.osVersion,
      state: "ready",
      interactive: target.interactive,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const record: PreviewRecord = { summary };
    this.previews.set(summary.previewId, record);
    this.emitState(record);
    return cloneSummary(summary);
  }

  rename(previewId: string, name: string): DevicePreviewSummary {
    this.assertRunning();
    const record = this.previews.get(previewId);
    if (!record) throw new DevicePreviewOperationError("设备预览不存在");
    const normalized = this.normalizeRequiredName(name);
    if (record.summary.name === normalized) return cloneSummary(record.summary);
    record.summary = { ...record.summary, name: normalized, updatedAt: this.now() };
    this.emitState(record);
    return cloneSummary(record.summary);
  }

  async startStream(input: DevicePreviewStreamStart): Promise<DevicePreviewStreamStarted> {
    this.assertRunning();
    const existing = this.viewers.get(input.streamId);
    if (existing) {
      if (existing.leaseId !== input.leaseId || existing.previewId !== input.previewId) {
        throw new DevicePreviewOperationError(
          "设备画面流标识已被占用",
          ControlErrorCode.CONTROL_LEASE_INVALID,
        );
      }
      const target = this.targets.get(existing.targetId);
      const result = {
        streamId: existing.streamId,
        leaseId: existing.leaseId,
        previewId: existing.previewId,
        format: existing.format,
      };
      return target?.width !== undefined && target.height !== undefined
        ? { ...result, width: target.width, height: target.height }
        : result;
    }

    const pending = this.pendingStarts.get(input.streamId);
    if (pending) {
      if (pending.leaseId !== input.leaseId || pending.previewId !== input.previewId) {
        throw new DevicePreviewOperationError(
          "设备画面流标识已被占用",
          ControlErrorCode.CONTROL_LEASE_INVALID,
        );
      }
      return pending.promise!;
    }

    if (
      this.leaseViewers.has(input.leaseId) ||
      [...this.pendingStarts.values()].some((start) => start.leaseId === input.leaseId)
    ) {
      throw new DevicePreviewOperationError(
        "设备控制租约已被占用",
        ControlErrorCode.CONTROL_LEASE_INVALID,
      );
    }
    if (this.viewers.size + this.pendingStarts.size >= MAX_DEVICE_VIEWERS) {
      throw new DevicePreviewOperationError(
        `每台开发机最多可同时打开 ${MAX_DEVICE_VIEWERS} 个设备画面`,
        ControlErrorCode.STREAM_CAPACITY_EXCEEDED,
      );
    }

    const start: PendingStreamStart = {
      streamId: input.streamId,
      leaseId: input.leaseId,
      previewId: input.previewId,
      cancelled: false,
    };
    this.pendingStarts.set(start.streamId, start);
    const operation = this.startStreamOnce(input, start).finally(() => {
      if (this.pendingStarts.get(start.streamId) === start) {
        this.pendingStarts.delete(start.streamId);
      }
    });
    start.promise = operation;
    return operation;
  }

  private async startStreamOnce(
    input: DevicePreviewStreamStart,
    start: PendingStreamStart,
  ): Promise<DevicePreviewStreamStarted> {
    const record = this.previews.get(input.previewId);
    if (!record) throw new DevicePreviewOperationError("设备预览不存在");
    let target = this.targets.get(record.summary.targetId);
    if (!target) {
      await this.discoverTargets(true);
      this.assertPendingStart(start);
      target = this.targets.get(record.summary.targetId);
    }
    this.assertPendingStart(start);
    if (this.previews.get(input.previewId) !== record) {
      throw new DevicePreviewOperationError("设备预览已关闭");
    }
    if (!target) {
      this.updateState(record, "disconnected");
      throw new DevicePreviewOperationError("模拟器没有运行");
    }
    // Each target has one canonical wire format. Android requires the Scrcpy H.264 pipeline.
    const format = validateStreamProfile(input, target.platform);

    const viewer: Viewer = {
      streamId: input.streamId,
      leaseId: input.leaseId,
      previewId: input.previewId,
      targetId: target.targetId,
      format,
      maxFps: boundedMaxFps(input.format === "jpeg" ? input.maxFps : undefined),
      paused: false,
      stopped: false,
      sending: false,
      frameSequence: 0,
      lastSentAt: 0,
      h264Queue: [],
      needsKeyframe: format === "h264_annex_b",
      inputAbort: new AbortController(),
    };
    this.viewers.set(viewer.streamId, viewer);
    this.leaseViewers.set(viewer.leaseId, viewer);
    this.leaseInputs.set(viewer.leaseId, {
      highestSequence: -1,
      results: new Map(),
      pendingSequences: new Set(),
    });
    this.addViewerToCapture(viewer);
    if (record.summary.state !== "ready") this.updateState(record, "ready");

    const result = {
      streamId: viewer.streamId,
      leaseId: viewer.leaseId,
      previewId: viewer.previewId,
      format: viewer.format,
    };
    return target.width !== undefined && target.height !== undefined
      ? { ...result, width: target.width, height: target.height }
      : result;
  }

  stopStream(streamId: string): void {
    this.cancelPendingStart(streamId);
    const viewer = this.viewers.get(streamId);
    if (!viewer) return;
    this.removeViewer(viewer);
  }

  hasLease(leaseId: string): boolean {
    const viewer = this.leaseViewers.get(leaseId);
    return !!viewer && !viewer.stopped;
  }

  async reconnect(previewId: string): Promise<void> {
    this.assertRunning();
    const record = this.previews.get(previewId);
    if (!record) throw new DevicePreviewOperationError("设备预览不存在");
    await this.discoverTargets(true);
    this.assertRunning();
    if (this.previews.get(previewId) !== record) {
      throw new DevicePreviewOperationError("设备预览已关闭");
    }
    if (!this.targets.has(record.summary.targetId)) {
      this.updateState(record, "disconnected");
      throw new DevicePreviewOperationError("模拟器没有运行");
    }
    this.updateState(record, "ready");
  }

  setFlowPaused(streamId: string, paused: boolean, resyncRequired: boolean): void {
    const viewer = this.viewers.get(streamId);
    if (!viewer || viewer.stopped) return;
    if (paused) {
      if (viewer.paused) return;
      viewer.paused = true;
      if (viewer.format === "h264_annex_b" && viewer.h264Queue.length > 0) {
        viewer.h264Queue = [];
        viewer.needsKeyframe = true;
      }
      const capture = this.captures.get(viewer.targetId);
      if (viewer.format === "h264_annex_b" && capture) {
        this.cancelSatisfiedKeyframeRequest(capture);
      }
      return;
    }

    if (!viewer.paused && !resyncRequired) return;
    viewer.paused = false;
    if (viewer.format === "h264_annex_b" && resyncRequired) {
      viewer.h264Queue = [];
      viewer.needsKeyframe = true;
    }
    if (viewer.format === "h264_annex_b" && viewer.needsKeyframe) {
      const capture = this.captures.get(viewer.targetId);
      if (capture?.h264Configuration) this.requestH264Keyframe(capture);
    }
    if (viewer.format === "jpeg") {
      const capture = this.captures.get(viewer.targetId);
      if (capture?.latestFrame) viewer.pendingFrame = capture.latestFrame;
    }
    this.flushViewer(viewer);
  }

  sendInput(leaseId: string, inputSequence: number, input: DevicePreviewInput): Promise<void> {
    this.assertRunning();
    validateInputSequence(inputSequence);
    const viewer = this.leaseViewers.get(leaseId);
    if (!viewer || viewer.stopped) {
      return Promise.reject(
        new DevicePreviewOperationError(
          "设备控制租约已失效",
          ControlErrorCode.CONTROL_LEASE_INVALID,
        ),
      );
    }
    const state = this.leaseInputs.get(leaseId);
    if (!state) {
      return Promise.reject(
        new DevicePreviewOperationError(
          "设备控制租约已失效",
          ControlErrorCode.CONTROL_LEASE_INVALID,
        ),
      );
    }
    const duplicate = state.results.get(inputSequence);
    if (duplicate) return duplicate;
    if (inputSequence <= state.highestSequence) return Promise.resolve();
    if (state.pendingSequences.size >= MAX_OUTSTANDING_INPUTS_PER_LEASE) {
      return Promise.reject(
        new DevicePreviewOperationError("设备输入队列已满", ControlErrorCode.RATE_LIMITED),
      );
    }
    state.highestSequence = inputSequence;

    const inputAbort = viewer.inputAbort;
    const previous = this.targetInputQueues.get(viewer.targetId) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          viewer.stopped ||
          this.leaseViewers.get(leaseId) !== viewer ||
          inputAbort.signal.aborted
        ) {
          throw new DevicePreviewOperationError(
            "设备控制租约已失效",
            ControlErrorCode.CONTROL_LEASE_INVALID,
          );
        }
        const record = this.previews.get(viewer.previewId);
        if (!record) throw new DevicePreviewOperationError("设备预览不存在");
        if (!record.summary.interactive) {
          throw new DevicePreviewOperationError("当前设备仅支持查看画面");
        }
        if (input.kind === "orientation" && this.activeTouches.has(viewer.targetId)) {
          // Rotation changes the coordinate space. Clear Manager ownership before awaiting the
          // native all-UP so either release or rotation failure leaves the gesture fail-closed.
          this.activeTouches.delete(viewer.targetId);
          await this.backend.releaseInput(viewer.targetId);
        }
        if (input.kind === "touch") {
          const activeTouch = this.activeTouches.get(viewer.targetId);
          if (input.phase === "down") {
            if (activeTouch) {
              throw new DevicePreviewOperationError(
                activeTouch.leaseId === leaseId
                  ? "设备触控手势已经开始"
                  : "设备正在处理另一条触控手势",
              );
            }
            this.activeTouches.set(viewer.targetId, { leaseId });
          } else if (activeTouch?.leaseId !== leaseId) {
            throw new DevicePreviewOperationError("设备触控手势尚未开始");
          }
        }
        try {
          await this.backend.sendInput(viewer.targetId, input, inputAbort.signal);
        } catch (error) {
          if (
            input.kind === "touch" &&
            this.activeTouches.get(viewer.targetId)?.leaseId === leaseId
          ) {
            this.activeTouches.delete(viewer.targetId);
            await this.releaseInputBestEffort(viewer.targetId);
          }
          throw error;
        }
        if (
          input.kind === "touch" &&
          input.phase === "up" &&
          this.activeTouches.get(viewer.targetId)?.leaseId === leaseId
        ) {
          this.activeTouches.delete(viewer.targetId);
        }
      });
    this.targetInputQueues.set(viewer.targetId, execution);
    void execution.then(
      () => this.cleanupInputQueue(viewer.targetId, execution),
      () => this.cleanupInputQueue(viewer.targetId, execution),
    );

    state.results.set(inputSequence, execution);
    state.pendingSequences.add(inputSequence);
    void execution.then(
      () => state.pendingSequences.delete(inputSequence),
      () => state.pendingSequences.delete(inputSequence),
    );
    while (state.results.size > INPUT_RESULT_CACHE_SIZE) {
      const oldest = state.results.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      state.results.delete(oldest);
    }
    return execution;
  }

  /** Abort only input owned by this lease; its viewer/capture remains available for takeover. */
  revokeInput(leaseId: string): void {
    const viewer = this.leaseViewers.get(leaseId);
    if (!viewer || viewer.stopped) return;
    viewer.inputAbort.abort();
    this.queueActiveTouchRelease(viewer);
    viewer.inputAbort = new AbortController();
    const state = this.leaseInputs.get(leaseId);
    this.leaseInputs.set(leaseId, {
      highestSequence: state?.highestSequence ?? -1,
      results: new Map(),
      pendingSequences: new Set(),
    });
  }

  close(previewId: string): void {
    const record = this.previews.get(previewId);
    if (!record) return;
    for (const start of [...this.pendingStarts.values()]) {
      if (start.previewId === previewId) this.cancelPendingStart(start.streamId);
    }
    this.stopPreviewViewers(previewId, "设备预览已关闭");
    this.releaseTargetIfIdle(record.summary.targetId);
    this.previews.delete(previewId);
    this.revision += 1;
    this.onEvent?.({ type: "removed", epoch: this.epoch, revision: this.revision, previewId });
  }

  disconnectTransport(): void {
    this.cancelAllPendingStarts();
    for (const viewer of [...this.viewers.values()]) this.removeViewer(viewer);
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shuttingDown = true;
    // Publish the shared task before cleanup begins. releaseTarget() is an adapter boundary and may
    // synchronously re-enter shutdown; every caller must still wait for the same complete teardown.
    this.shutdownTask = Promise.resolve().then(() => this.shutdownOnce());
    return this.shutdownTask;
  }

  private async shutdownOnce(): Promise<void> {
    const pendingStarts = [...this.pendingStarts.values()];
    const captures = [...this.captures.values()];
    this.cancelAllPendingStarts();
    for (const viewer of [...this.viewers.values()]) this.removeViewer(viewer);
    const inputQueues = [...this.targetInputQueues.values()];
    await Promise.allSettled(inputQueues);
    this.captures.clear();
    for (const capture of captures) {
      capture.latestFrame = undefined;
      capture.h264Configuration = undefined;
      this.clearKeyframeRequest(capture);
      capture.abort.abort();
    }
    await Promise.allSettled([
      ...captures.map((capture) => capture.task),
      ...pendingStarts.flatMap((start) => (start.promise ? [start.promise] : [])),
    ]);
    await Promise.allSettled([...this.targetAvailabilityProbes.values()]);
    await this.backend.dispose();
  }

  private addViewerToCapture(viewer: Viewer): void {
    let capture = this.captures.get(viewer.targetId);
    if (!capture) {
      const abort = new AbortController();
      capture = {
        targetId: viewer.targetId,
        viewers: new Set(),
        abort,
        task: Promise.resolve(),
        keyframeRequestInFlight: false,
        keyframeRequestGeneration: 0,
        lastKeyframeRequestAt: Number.NEGATIVE_INFINITY,
        keyframeRequestAttempts: 0,
      };
      this.captures.set(viewer.targetId, capture);
      capture.viewers.add(viewer.streamId);
      capture.task = this.runCapture(capture);
      return;
    }
    capture.viewers.add(viewer.streamId);
    if (viewer.format === "jpeg" && capture.latestFrame) {
      this.offerJpegFrame(viewer, capture.latestFrame);
    } else if (viewer.format === "h264_annex_b" && capture.h264Configuration) {
      this.requestH264Keyframe(capture);
    }
  }

  private async runCapture(capture: CaptureGroup): Promise<void> {
    try {
      await this.backend.capture(capture.targetId, capture.abort.signal, (frame) => {
        if (capture.abort.signal.aborted) return;
        const bytes = frame.format === "h264_annex_b" ? frame.data : frame.jpeg;
        if (bytes.length === 0 || bytes.length > DEVICE_PREVIEW_FRAME_MAX_BYTES) {
          throw new DevicePreviewOperationError("设备画面超过传输大小限制");
        }
        if (frame.format === "h264_annex_b") {
          if (frame.kind === "configuration") {
            capture.h264Configuration = {
              ...frame,
              data: Buffer.from(frame.data),
            };
          }
        } else {
          capture.latestFrame = frame;
        }
        for (const streamId of capture.viewers) {
          const viewer = this.viewers.get(streamId);
          if (!viewer) continue;
          if (frame.format === "h264_annex_b") {
            this.offerH264Packet(viewer, capture, frame);
          } else {
            this.offerJpegFrame(viewer, frame);
          }
        }
        if (frame.format === "h264_annex_b" && frame.kind === "frame" && frame.keyframe) {
          this.cancelSatisfiedKeyframeRequest(capture);
        }
      });
      if (!capture.abort.signal.aborted) {
        throw new DevicePreviewOperationError("设备画面采集已停止");
      }
    } catch (error) {
      if (!capture.abort.signal.aborted) this.failCapture(capture, error);
    } finally {
      capture.latestFrame = undefined;
      capture.h264Configuration = undefined;
      this.clearKeyframeRequest(capture);
      if (this.captures.get(capture.targetId) === capture) {
        this.captures.delete(capture.targetId);
      }
    }
  }

  private failCapture(capture: CaptureGroup, error: unknown): void {
    const message = publicError(error);
    serviceLogger.warn(
      { targetId: capture.targetId, error: message },
      "Device preview capture failed",
    );
    for (const streamId of [...capture.viewers]) {
      const viewer = this.viewers.get(streamId);
      if (!viewer) continue;
      this.streamTransport.sendComplete({
        streamId: viewer.streamId,
        leaseId: viewer.leaseId,
        previewId: viewer.previewId,
        success: false,
        error: message,
      });
      this.removeViewer(viewer);
    }
    this.probeTargetAvailability(capture.targetId);
  }

  private probeTargetAvailability(targetId: string): void {
    if (this.shuttingDown || this.targetAvailabilityProbes.has(targetId)) return;
    const probe = this.discoverTargets(false)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.shuttingDown) return;
        serviceLogger.warn(
          { targetId, error: publicError(error) },
          "Could not refresh device availability after capture failure",
        );
      })
      .finally(() => {
        if (this.targetAvailabilityProbes.get(targetId) === probe) {
          this.targetAvailabilityProbes.delete(targetId);
        }
      });
    this.targetAvailabilityProbes.set(targetId, probe);
  }

  private requestH264Keyframe(capture: CaptureGroup): void {
    if (
      capture.abort.signal.aborted ||
      this.captures.get(capture.targetId) !== capture ||
      !this.captureNeedsH264Keyframe(capture) ||
      capture.keyframeRequestInFlight ||
      capture.keyframeRequestTimer ||
      capture.keyframeResponseTimer
    ) {
      return;
    }
    const delay = capture.lastKeyframeRequestAt + H264_KEYFRAME_REQUEST_COOLDOWN_MS - this.now();
    if (delay > 0) {
      capture.keyframeRequestTimer = setTimeout(() => {
        capture.keyframeRequestTimer = undefined;
        this.requestH264Keyframe(capture);
      }, Math.ceil(delay));
      capture.keyframeRequestTimer.unref?.();
      return;
    }

    capture.keyframeRequestInFlight = true;
    capture.keyframeRequestAttempts += 1;
    capture.lastKeyframeRequestAt = this.now();
    const requestGeneration = capture.keyframeRequestGeneration;
    void this.backend.requestKeyframe(capture.targetId).then(
      () => {
        if (!this.isCurrentKeyframeRequest(capture, requestGeneration)) return;
        capture.keyframeRequestInFlight = false;
        if (
          capture.abort.signal.aborted ||
          this.captures.get(capture.targetId) !== capture ||
          !this.captureNeedsH264Keyframe(capture)
        ) {
          this.cancelSatisfiedKeyframeRequest(capture);
          return;
        }
        capture.keyframeResponseTimer = setTimeout(() => {
          capture.keyframeResponseTimer = undefined;
          if (
            !this.isCurrentKeyframeRequest(capture, requestGeneration) ||
            !this.captureNeedsH264Keyframe(capture)
          ) {
            this.cancelSatisfiedKeyframeRequest(capture);
            return;
          }
          if (capture.keyframeRequestAttempts < MAX_H264_KEYFRAME_REQUEST_ATTEMPTS) {
            this.requestH264Keyframe(capture);
            return;
          }
          this.failH264Recovery(
            capture,
            new DevicePreviewOperationError("Android 模拟器画面恢复超时"),
          );
        }, H264_KEYFRAME_RESPONSE_TIMEOUT_MS);
        capture.keyframeResponseTimer.unref?.();
      },
      (error: unknown) => {
        if (!this.isCurrentKeyframeRequest(capture, requestGeneration)) return;
        capture.keyframeRequestInFlight = false;
        serviceLogger.warn(
          { targetId: capture.targetId, error: String(error) },
          "Could not reset Android device preview video",
        );
        this.failH264Recovery(
          capture,
          new DevicePreviewOperationError("无法恢复 Android 模拟器画面"),
        );
      },
    );
  }

  private isCurrentKeyframeRequest(capture: CaptureGroup, generation: number): boolean {
    return (
      !capture.abort.signal.aborted &&
      this.captures.get(capture.targetId) === capture &&
      capture.keyframeRequestGeneration === generation
    );
  }

  private failH264Recovery(capture: CaptureGroup, error: unknown): void {
    const awaitingViewers = [...capture.viewers]
      .map((streamId) => this.viewers.get(streamId))
      .filter(
        (viewer): viewer is Viewer =>
          viewer?.format === "h264_annex_b" && !viewer.paused && viewer.needsKeyframe,
      );
    this.clearKeyframeRequest(capture);
    for (const viewer of awaitingViewers) this.failViewer(viewer, error);
  }

  private captureNeedsH264Keyframe(capture: CaptureGroup): boolean {
    for (const streamId of capture.viewers) {
      const viewer = this.viewers.get(streamId);
      if (viewer?.format === "h264_annex_b" && !viewer.paused && viewer.needsKeyframe) {
        return true;
      }
    }
    return false;
  }

  private cancelSatisfiedKeyframeRequest(capture: CaptureGroup): void {
    if (this.captureNeedsH264Keyframe(capture)) return;
    this.clearKeyframeRequest(capture);
  }

  private clearKeyframeRequest(capture: CaptureGroup): void {
    if (capture.keyframeRequestTimer) clearTimeout(capture.keyframeRequestTimer);
    if (capture.keyframeResponseTimer) clearTimeout(capture.keyframeResponseTimer);
    capture.keyframeRequestTimer = undefined;
    capture.keyframeResponseTimer = undefined;
    capture.keyframeRequestInFlight = false;
    capture.keyframeRequestAttempts = 0;
    capture.keyframeRequestGeneration += 1;
  }

  private offerJpegFrame(viewer: Viewer, frame: DevicePreviewJpegFrame): void {
    if (viewer.stopped || viewer.format !== "jpeg") return;
    viewer.pendingFrame = frame;
    this.flushViewer(viewer);
  }

  private offerH264Packet(
    viewer: Viewer,
    capture: CaptureGroup,
    packet: DevicePreviewH264Packet,
  ): void {
    if (viewer.stopped || viewer.format !== "h264_annex_b") return;
    if (packet.kind === "configuration") {
      viewer.needsKeyframe = true;
      viewer.h264Queue = [];
      return;
    }
    if (viewer.paused) {
      viewer.needsKeyframe = true;
      viewer.h264Queue = [];
      return;
    }
    if (viewer.needsKeyframe) {
      if (!packet.keyframe || !capture.h264Configuration) return;
      viewer.h264Queue.push(capture.h264Configuration, packet);
      viewer.needsKeyframe = false;
      this.flushViewer(viewer);
      return;
    }
    if (viewer.h264Queue.length >= MAX_H264_QUEUE_PACKETS) {
      viewer.h264Queue = [];
      viewer.needsKeyframe = true;
      this.requestH264Keyframe(capture);
      return;
    }
    viewer.h264Queue.push(packet);
    this.flushViewer(viewer);
  }

  private flushViewer(viewer: Viewer): void {
    if (viewer.stopped || viewer.paused || viewer.sending) return;
    if (viewer.format === "h264_annex_b") {
      this.flushH264Viewer(viewer);
      return;
    }
    if (!viewer.pendingFrame) return;
    const minimumInterval = 1_000 / viewer.maxFps;
    const delay = minimumInterval - (this.now() - viewer.lastSentAt);
    if (delay > 0) {
      if (!viewer.sendTimer) {
        viewer.sendTimer = setTimeout(() => {
          viewer.sendTimer = undefined;
          this.flushViewer(viewer);
        }, Math.ceil(delay));
        viewer.sendTimer.unref?.();
      }
      return;
    }

    const frame = viewer.pendingFrame;
    viewer.pendingFrame = undefined;
    viewer.sending = true;
    const sequence = viewer.frameSequence;
    viewer.frameSequence = (viewer.frameSequence + 1) >>> 0;
    viewer.lastSentAt = this.now();
    void Promise.resolve(
      this.streamTransport.sendFrame(viewer.streamId, sequence, frame.jpeg),
    ).then(
      () => {
        viewer.sending = false;
        this.flushViewer(viewer);
      },
      (error: unknown) => {
        viewer.sending = false;
        if (viewer.stopped) return;
        this.streamTransport.sendComplete({
          streamId: viewer.streamId,
          leaseId: viewer.leaseId,
          previewId: viewer.previewId,
          success: false,
          error: publicError(error),
        });
        this.removeViewer(viewer);
      },
    );
  }

  private flushH264Viewer(viewer: Viewer): void {
    const packet = viewer.h264Queue.shift();
    if (!packet) return;
    const sendH264Packet = this.streamTransport.sendH264Packet;
    viewer.sending = true;
    const sequence = viewer.frameSequence;
    viewer.frameSequence = (viewer.frameSequence + 1) >>> 0;
    void Promise.resolve(
      sendH264Packet.call(this.streamTransport, viewer.streamId, sequence, packet),
    ).then(
      () => {
        viewer.sending = false;
        this.flushViewer(viewer);
      },
      (error: unknown) => {
        viewer.sending = false;
        this.failViewer(viewer, error);
      },
    );
  }

  private failViewer(viewer: Viewer, error: unknown): void {
    if (viewer.stopped) return;
    this.streamTransport.sendComplete({
      streamId: viewer.streamId,
      leaseId: viewer.leaseId,
      previewId: viewer.previewId,
      success: false,
      error: publicError(error),
    });
    this.removeViewer(viewer);
  }

  private removeViewer(viewer: Viewer): void {
    if (viewer.stopped) return;
    viewer.stopped = true;
    viewer.inputAbort.abort();
    const touchRelease = this.queueActiveTouchRelease(viewer);
    if (viewer.sendTimer) clearTimeout(viewer.sendTimer);
    viewer.sendTimer = undefined;
    viewer.pendingFrame = undefined;
    viewer.h264Queue = [];
    this.viewers.delete(viewer.streamId);
    if (this.leaseViewers.get(viewer.leaseId) === viewer) {
      this.leaseViewers.delete(viewer.leaseId);
      this.leaseInputs.delete(viewer.leaseId);
    }

    const capture = this.captures.get(viewer.targetId);
    if (!capture) {
      this.releaseTargetIfIdle(viewer.targetId);
      return;
    }
    capture.viewers.delete(viewer.streamId);
    if (capture.viewers.size > 0) {
      this.cancelSatisfiedKeyframeRequest(capture);
      return;
    }
    const stopCapture = (): void => {
      if (this.captures.get(viewer.targetId) !== capture || capture.viewers.size > 0) return;
      this.captures.delete(viewer.targetId);
      capture.latestFrame = undefined;
      capture.h264Configuration = undefined;
      this.clearKeyframeRequest(capture);
      capture.abort.abort();
      this.releaseTargetIfIdle(viewer.targetId);
    };
    const pendingInput = touchRelease ?? this.targetInputQueues.get(viewer.targetId);
    if (pendingInput) {
      void pendingInput.then(stopCapture, stopCapture);
      return;
    }
    stopCapture();
  }

  private stopPreviewViewers(previewId: string, reason: string, notify = false): void {
    for (const viewer of [...this.viewers.values()]) {
      if (viewer.previewId !== previewId) continue;
      if (notify) {
        this.streamTransport.sendComplete({
          streamId: viewer.streamId,
          leaseId: viewer.leaseId,
          previewId: viewer.previewId,
          success: false,
          error: reason,
        });
      }
      this.removeViewer(viewer);
    }
  }

  private cleanupInputQueue(targetId: string, queue: Promise<void>): void {
    if (this.targetInputQueues.get(targetId) === queue) this.targetInputQueues.delete(targetId);
  }

  private queueActiveTouchRelease(viewer: Viewer): Promise<void> | undefined {
    if (this.activeTouches.get(viewer.targetId)?.leaseId !== viewer.leaseId) return undefined;
    this.activeTouches.delete(viewer.targetId);
    const previous = this.targetInputQueues.get(viewer.targetId) ?? Promise.resolve();
    const release = previous
      .catch(() => undefined)
      .then(() => this.releaseInputBestEffort(viewer.targetId));
    this.targetInputQueues.set(viewer.targetId, release);
    void release.then(
      () => this.cleanupInputQueue(viewer.targetId, release),
      () => this.cleanupInputQueue(viewer.targetId, release),
    );
    return release;
  }

  private async releaseInputBestEffort(targetId: string): Promise<void> {
    try {
      await this.backend.releaseInput(targetId);
    } catch (error) {
      serviceLogger.warn(
        { targetId, error: publicError(error) },
        "Device preview active touch release failed",
      );
    }
  }

  private assertPendingStart(start: PendingStreamStart): void {
    this.assertRunning();
    if (start.cancelled || this.pendingStarts.get(start.streamId) !== start) {
      throw new DevicePreviewOperationError("设备画面流启动已取消");
    }
  }

  private cancelPendingStart(streamId: string): void {
    const start = this.pendingStarts.get(streamId);
    if (!start) return;
    start.cancelled = true;
    this.pendingStarts.delete(streamId);
  }

  private cancelAllPendingStarts(): void {
    for (const start of this.pendingStarts.values()) start.cancelled = true;
    this.pendingStarts.clear();
  }

  private releaseTargetIfIdle(targetId: string): void {
    if ([...this.viewers.values()].some((viewer) => viewer.targetId === targetId)) return;
    if (this.pendingTargetReleases.has(targetId)) return;
    const inputQueue = this.targetInputQueues.get(targetId);
    if (inputQueue) {
      this.pendingTargetReleases.add(targetId);
      void inputQueue.then(
        () => this.finishPendingTargetRelease(targetId, inputQueue),
        () => this.finishPendingTargetRelease(targetId, inputQueue),
      );
      return;
    }
    try {
      this.backend.releaseTarget(targetId);
    } catch (error) {
      serviceLogger.warn(
        { targetId, error: publicError(error) },
        "Device preview target resource release failed",
      );
    }
  }

  private finishPendingTargetRelease(targetId: string, inputQueue: Promise<void>): void {
    this.pendingTargetReleases.delete(targetId);
    this.cleanupInputQueue(targetId, inputQueue);
    this.releaseTargetIfIdle(targetId);
  }

  private updateState(record: PreviewRecord, state: DevicePreviewSummary["state"]): void {
    if (record.summary.state === state) return;
    record.summary = { ...record.summary, state, updatedAt: this.now() };
    this.emitState(record);
  }

  private updateTargetMetadata(record: PreviewRecord, target: DevicePreviewTarget): void {
    if (
      record.summary.model === target.model &&
      record.summary.osVersion === target.osVersion &&
      record.summary.interactive === target.interactive
    ) {
      return;
    }
    record.summary = {
      ...record.summary,
      model: target.model,
      osVersion: target.osVersion,
      interactive: target.interactive,
      updatedAt: this.now(),
    };
    this.emitState(record);
  }

  private emitState(record: PreviewRecord): void {
    this.revision += 1;
    this.onEvent?.({
      type: "state",
      epoch: this.epoch,
      revision: this.revision,
      preview: cloneSummary(record.summary),
    });
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new DevicePreviewOperationError("Proxy 正在停止");
  }

  private normalizeOptionalName(name: string | undefined): string | undefined {
    try {
      return normalizeOptionalPreviewName(name);
    } catch (error) {
      throw new DevicePreviewOperationError(error instanceof Error ? error.message : String(error));
    }
  }

  private normalizeRequiredName(name: string): string {
    try {
      return normalizeRequiredPreviewName(name);
    } catch (error) {
      throw new DevicePreviewOperationError(error instanceof Error ? error.message : String(error));
    }
  }
}
