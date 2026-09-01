import {
  DEVICE_PREVIEW_FRAME_MAX_BYTES,
  type DevicePreviewCapability,
  type DevicePreviewInput,
  type DevicePreviewSummary,
  type DevicePreviewTarget,
} from "@dev-anywhere/shared";
import { nanoid } from "nanoid";
import { serviceLogger } from "../../common/logger.js";
import type {
  DevicePreviewBackend,
  DevicePreviewFrame,
  DevicePreviewManagerEvent,
  DevicePreviewSnapshot,
  DevicePreviewStreamStarted,
  DevicePreviewStreamStart,
  DevicePreviewStreamTransport,
} from "./types.js";

const MAX_DEVICE_PREVIEWS = 16;
const MAX_DEVICE_VIEWERS = 8;
const OPERATION_ID_CACHE_SIZE = 128;
const INPUT_RESULT_CACHE_SIZE = 64;
const MAX_OUTSTANDING_INPUTS_PER_LEASE = 32;
const DEFAULT_MAX_FPS = 15;
const MIN_MAX_FPS = 1;
const MAX_MAX_FPS = 30;
const CAPTURE_MAX_WIDTH = 720;
const CAPTURE_JPEG_QUALITY = 70;
const MAX_PUBLIC_ERROR_LENGTH = 1_024;

interface PreviewRecord {
  summary: DevicePreviewSummary;
  operationIds: Set<string>;
}

interface Viewer {
  streamId: string;
  leaseId: string;
  previewId: string;
  targetId: string;
  maxFps: number;
  paused: boolean;
  stopped: boolean;
  sending: boolean;
  frameSequence: number;
  lastSentAt: number;
  pendingFrame?: DevicePreviewFrame;
  sendTimer?: NodeJS.Timeout;
  inputAbort: AbortController;
}

interface CaptureGroup {
  targetId: string;
  viewers: Set<string>;
  abort: AbortController;
  task: Promise<void>;
  latestFrame?: DevicePreviewFrame;
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

export interface DevicePreviewManagerOptions {
  backend: DevicePreviewBackend;
  streamTransport: DevicePreviewStreamTransport;
  onEvent?: (event: DevicePreviewManagerEvent) => void;
  now?: () => number;
}

export class DevicePreviewOperationError extends Error {
  constructor(message: string) {
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

function validateStreamProfile(input: DevicePreviewStreamStart): void {
  const maxWidth = input.maxWidth ?? CAPTURE_MAX_WIDTH;
  const jpegQuality = input.jpegQuality ?? CAPTURE_JPEG_QUALITY;
  if (maxWidth !== CAPTURE_MAX_WIDTH || jpegQuality !== CAPTURE_JPEG_QUALITY) {
    throw new DevicePreviewOperationError(
      `当前版本仅支持 ${CAPTURE_MAX_WIDTH}px、JPEG 质量 ${CAPTURE_JPEG_QUALITY} 的设备画面`,
    );
  }
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
  private readonly createOperations = new Map<string, Promise<DevicePreviewSummary>>();
  private readonly pendingStarts = new Map<string, PendingStreamStart>();
  private readonly viewers = new Map<string, Viewer>();
  private readonly leaseViewers = new Map<string, Viewer>();
  private readonly captures = new Map<string, CaptureGroup>();
  private readonly leaseInputs = new Map<string, LeaseInputState>();
  private readonly targetInputQueues = new Map<string, Promise<void>>();
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

  async discoverTargets(refresh = false): Promise<DevicePreviewTarget[]> {
    this.assertRunning();
    const targets = await this.backend.discoverTargets(refresh);
    this.assertRunning();
    this.targets.clear();
    for (const target of targets) this.targets.set(target.targetId, cloneTarget(target));

    const available = new Set(targets.map((target) => target.targetId));
    for (const record of this.previews.values()) {
      if (available.has(record.summary.targetId)) {
        if (record.summary.state === "disconnected") this.updateState(record, "ready");
      } else if (record.summary.state !== "disconnected") {
        this.stopPreviewViewers(record.summary.previewId, "设备已离线", true);
        this.releaseTargetIfIdle(record.summary.targetId);
        this.updateState(record, "disconnected");
      }
    }
    return targets.map(cloneTarget);
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

  create(operationId: string, targetId: string): Promise<DevicePreviewSummary> {
    this.assertRunning();
    const existingOperation = [...this.previews.values()].find((record) =>
      record.operationIds.has(operationId),
    );
    if (existingOperation) {
      this.rememberOperation(existingOperation, operationId);
      return Promise.resolve(cloneSummary(existingOperation.summary));
    }
    const inFlight = this.createOperations.get(operationId);
    if (inFlight) return inFlight.then(cloneSummary);

    const operation = this.createOnce(operationId, targetId).finally(() => {
      if (this.createOperations.get(operationId) === operation) {
        this.createOperations.delete(operationId);
      }
    });
    this.createOperations.set(operationId, operation);
    return operation.then(cloneSummary);
  }

  private async createOnce(operationId: string, targetId: string): Promise<DevicePreviewSummary> {
    let target = this.targets.get(targetId);
    if (!target) {
      await this.discoverTargets(true);
      target = this.targets.get(targetId);
    }
    if (!target) throw new DevicePreviewOperationError("没有找到正在运行的模拟器");

    const existingTarget = [...this.previews.values()].find(
      (record) => record.summary.targetId === targetId,
    );
    if (existingTarget) {
      this.rememberOperation(existingTarget, operationId);
      return cloneSummary(existingTarget.summary);
    }
    if (this.previews.size >= MAX_DEVICE_PREVIEWS) {
      throw new DevicePreviewOperationError(`最多可保留 ${MAX_DEVICE_PREVIEWS} 个设备预览`);
    }

    const timestamp = this.now();
    const summary: DevicePreviewSummary = {
      previewId: nanoid(),
      name: target.name,
      platform: target.platform,
      targetId: target.targetId,
      targetName: target.name,
      state: "ready",
      interactive: target.interactive,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const record: PreviewRecord = { summary, operationIds: new Set([operationId]) };
    this.previews.set(summary.previewId, record);
    this.emitState(record);
    return cloneSummary(summary);
  }

  async startStream(input: DevicePreviewStreamStart): Promise<DevicePreviewStreamStarted> {
    this.assertRunning();
    const existing = this.viewers.get(input.streamId);
    if (existing) {
      if (existing.leaseId !== input.leaseId || existing.previewId !== input.previewId) {
        throw new DevicePreviewOperationError("设备画面流标识已被占用");
      }
      const target = this.targets.get(existing.targetId);
      return {
        streamId: existing.streamId,
        leaseId: existing.leaseId,
        previewId: existing.previewId,
        ...(target?.width ? { width: target.width } : {}),
        ...(target?.height ? { height: target.height } : {}),
      };
    }

    const pending = this.pendingStarts.get(input.streamId);
    if (pending) {
      if (pending.leaseId !== input.leaseId || pending.previewId !== input.previewId) {
        throw new DevicePreviewOperationError("设备画面流标识已被占用");
      }
      return pending.promise!;
    }

    // Both platform adapters intentionally produce one shared 720/70 capture. Reject unsupported
    // profiles instead of silently pretending that per-viewer width/quality were applied.
    validateStreamProfile(input);
    if (
      this.leaseViewers.has(input.leaseId) ||
      [...this.pendingStarts.values()].some((start) => start.leaseId === input.leaseId)
    ) {
      throw new DevicePreviewOperationError("设备控制租约已被占用");
    }
    if (this.viewers.size + this.pendingStarts.size >= MAX_DEVICE_VIEWERS) {
      throw new DevicePreviewOperationError(
        `每台开发机最多可同时打开 ${MAX_DEVICE_VIEWERS} 个设备画面`,
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

    const viewer: Viewer = {
      streamId: input.streamId,
      leaseId: input.leaseId,
      previewId: input.previewId,
      targetId: target.targetId,
      maxFps: boundedMaxFps(input.maxFps),
      paused: false,
      stopped: false,
      sending: false,
      frameSequence: 0,
      lastSentAt: 0,
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

    return {
      streamId: viewer.streamId,
      leaseId: viewer.leaseId,
      previewId: viewer.previewId,
      ...(target.width ? { width: target.width } : {}),
      ...(target.height ? { height: target.height } : {}),
    };
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

  setFlowPaused(streamId: string, paused: boolean): void {
    const viewer = this.viewers.get(streamId);
    if (!viewer || viewer.stopped || viewer.paused === paused) return;
    viewer.paused = paused;
    if (!paused) this.flushViewer(viewer);
  }

  sendInput(leaseId: string, inputSequence: number, input: DevicePreviewInput): Promise<void> {
    this.assertRunning();
    validateInputSequence(inputSequence);
    const viewer = this.leaseViewers.get(leaseId);
    if (!viewer || viewer.stopped) {
      return Promise.reject(new DevicePreviewOperationError("设备控制租约已失效"));
    }
    const state = this.leaseInputs.get(leaseId);
    if (!state) return Promise.reject(new DevicePreviewOperationError("设备控制租约已失效"));
    const duplicate = state.results.get(inputSequence);
    if (duplicate) return duplicate;
    if (inputSequence <= state.highestSequence) return Promise.resolve();
    if (state.pendingSequences.size >= MAX_OUTSTANDING_INPUTS_PER_LEASE) {
      return Promise.reject(new DevicePreviewOperationError("设备输入队列已满"));
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
          throw new DevicePreviewOperationError("设备控制租约已失效");
        }
        const record = this.previews.get(viewer.previewId);
        if (!record) throw new DevicePreviewOperationError("设备预览不存在");
        if (!record.summary.interactive) {
          throw new DevicePreviewOperationError("当前设备仅支持查看画面");
        }
        await this.backend.sendInput(viewer.targetId, input, inputAbort.signal);
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
    viewer.inputAbort = new AbortController();
    this.leaseInputs.set(leaseId, {
      highestSequence: -1,
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
    this.captures.clear();
    for (const capture of captures) {
      capture.latestFrame = undefined;
      capture.abort.abort();
    }
    await Promise.allSettled([
      ...captures.map((capture) => capture.task),
      ...pendingStarts.flatMap((start) => (start.promise ? [start.promise] : [])),
    ]);
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
      };
      this.captures.set(viewer.targetId, capture);
      capture.viewers.add(viewer.streamId);
      capture.task = this.runCapture(capture);
      return;
    }
    capture.viewers.add(viewer.streamId);
    if (capture.latestFrame) this.offerFrame(viewer, capture.latestFrame);
  }

  private async runCapture(capture: CaptureGroup): Promise<void> {
    try {
      await this.backend.capture(capture.targetId, capture.abort.signal, (frame) => {
        if (capture.abort.signal.aborted) return;
        if (frame.jpeg.length === 0 || frame.jpeg.length > DEVICE_PREVIEW_FRAME_MAX_BYTES) {
          throw new DevicePreviewOperationError("设备画面超过传输大小限制");
        }
        capture.latestFrame = frame;
        for (const streamId of capture.viewers) {
          const viewer = this.viewers.get(streamId);
          if (viewer) this.offerFrame(viewer, frame);
        }
      });
      if (!capture.abort.signal.aborted) {
        throw new DevicePreviewOperationError("设备画面采集已停止");
      }
    } catch (error) {
      if (!capture.abort.signal.aborted) this.failCapture(capture, error);
    } finally {
      capture.latestFrame = undefined;
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
    for (const record of this.previews.values()) {
      if (record.summary.targetId === capture.targetId) this.updateState(record, "failed", message);
    }
  }

  private offerFrame(viewer: Viewer, frame: DevicePreviewFrame): void {
    if (viewer.stopped) return;
    viewer.pendingFrame = frame;
    this.flushViewer(viewer);
  }

  private flushViewer(viewer: Viewer): void {
    if (viewer.stopped || viewer.paused || viewer.sending || !viewer.pendingFrame) return;
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

  private removeViewer(viewer: Viewer): void {
    if (viewer.stopped) return;
    viewer.stopped = true;
    viewer.inputAbort.abort();
    if (viewer.sendTimer) clearTimeout(viewer.sendTimer);
    viewer.sendTimer = undefined;
    viewer.pendingFrame = undefined;
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
    if (capture.viewers.size > 0) return;
    this.captures.delete(viewer.targetId);
    capture.latestFrame = undefined;
    capture.abort.abort();
    this.releaseTargetIfIdle(viewer.targetId);
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

  private rememberOperation(record: PreviewRecord, operationId: string): void {
    record.operationIds.delete(operationId);
    record.operationIds.add(operationId);
    while (record.operationIds.size > OPERATION_ID_CACHE_SIZE) {
      const oldest = record.operationIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      record.operationIds.delete(oldest);
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
    try {
      this.backend.releaseTarget?.(targetId);
    } catch (error) {
      serviceLogger.warn(
        { targetId, error: publicError(error) },
        "Device preview target resource release failed",
      );
    }
  }

  private updateState(
    record: PreviewRecord,
    state: DevicePreviewSummary["state"],
    error?: string,
  ): void {
    if (record.summary.state === state && record.summary.error === error) return;
    record.summary = {
      ...record.summary,
      state,
      updatedAt: this.now(),
      ...(error ? { error } : {}),
    };
    if (!error) delete record.summary.error;
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
}
