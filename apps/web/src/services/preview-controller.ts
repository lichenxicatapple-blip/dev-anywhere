import type {
  DevicePreviewInput,
  DevicePreviewStreamProfile,
  DevicePreviewSummary,
  PreviewSummary,
  TunnelProvider,
  WebPreviewSourceInput,
} from "@dev-anywhere/shared";
import { createClientOperationId } from "@/lib/client-operation-id";
import {
  findPreviewPendingOperation,
  listPreviewPendingOperations,
  listPreviewPendingOperationsForPreview,
  type PreviewPendingOperation,
  type PreviewPendingOperationKind,
  type PreviewPendingResourceKind,
} from "@/services/preview-pending-operations";
import { createPreviewScope, samePreviewScope, type PreviewScope } from "@/services/preview-scope";
import type { InboundMessage, RelayClient } from "@/services/relay-client";
import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { usePreviewOperationStore } from "@/stores/preview-operation-store";
import { usePreviewStore } from "@/stores/preview-store";

export type PreviewControllerRelay = Pick<
  RelayClient,
  | "getPreviewScope"
  | "inspectStaticWebPreview"
  | "requestWebPreviewCapability"
  | "createWebPreview"
  | "requestWebPreviewList"
  | "renameWebPreview"
  | "reconnectWebPreview"
  | "closeWebPreview"
  | "requestDevicePreviewCapability"
  | "requestDevicePreviewTargets"
  | "requestDevicePreviewStream"
  | "sendDevicePreviewInput"
  | "claimDevicePreviewControl"
  | "createDevicePreview"
  | "requestDevicePreviewList"
  | "renameDevicePreview"
  | "reconnectDevicePreview"
  | "closeDevicePreview"
>;

type WebPreviewReduceResult = ReturnType<
  ReturnType<typeof usePreviewStore.getState>["replaceSnapshot"]
>;
type DevicePreviewReduceResult = ReturnType<
  ReturnType<typeof useDevicePreviewStore.getState>["replaceSnapshot"]
>;

interface PreviewOperationRequestOptions {
  /** Reuse this value when retrying an operation whose ACK may have been lost. */
  readonly operationId?: string;
  readonly timeoutMs?: number;
}

interface PreviewQueryRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface CreateWebPreviewOptions extends PreviewOperationRequestOptions {
  readonly tunnelProvider: TunnelProvider;
  readonly name?: string;
}

interface CreateDevicePreviewOptions extends PreviewOperationRequestOptions {
  readonly name?: string;
}

export type ScopedDevicePreviewStreamAccess = Awaited<
  ReturnType<PreviewControllerRelay["requestDevicePreviewStream"]>
> & {
  readonly scope: PreviewScope;
  readonly signal: AbortSignal;
};

export type ActiveDevicePreviewStreamAccess = ScopedDevicePreviewStreamAccess & {
  readonly success: true;
  readonly url: string;
  readonly leaseId: string;
};

type PreviewControllerBackgroundTask =
  | "web-resync"
  | "device-resync"
  | "web-reconciliation"
  | "device-reconciliation";

const RESYNC_RETRY_BASE_DELAY_MS = 100;
const RESYNC_RETRY_MAX_DELAY_MS = 5_000;

interface PreviewControllerOptions {
  readonly createOperationId?: (prefix: string) => string;
  readonly now?: () => number;
  readonly reportBackgroundError?: (task: PreviewControllerBackgroundTask, error: unknown) => void;
}

class PreviewScopeInactiveError extends Error {
  readonly scope: PreviewScope;

  constructor(scope: PreviewScope) {
    super("预览上下文已失效，请重新选择开发机");
    this.name = "PreviewScopeInactiveError";
    this.scope = scope;
  }
}

export class PreviewCreateConfirmationError extends Error {
  readonly previewKind: PreviewPendingResourceKind;
  readonly previewId: string;
  readonly confirmationCause: unknown;

  constructor(
    previewKind: PreviewPendingResourceKind,
    previewId: string,
    confirmationCause?: unknown,
  ) {
    super(
      previewKind === "web"
        ? "网页预览已创建，但暂时无法确认状态，请重试"
        : "模拟器预览已创建，但暂时无法确认状态，请重试",
    );
    this.name = "PreviewCreateConfirmationError";
    this.previewKind = previewKind;
    this.previewId = previewId;
    this.confirmationCause = confirmationCause;
  }
}

export class PreviewOperationConflictError extends Error {
  readonly previewKind: PreviewPendingResourceKind;
  readonly operationKind: PreviewPendingOperationKind;
  readonly previewId?: string;
  readonly reason: "resource-busy" | "operation-id-conflict";

  constructor(
    previewKind: PreviewPendingResourceKind,
    operationKind: PreviewPendingOperationKind,
    previewId?: string,
    reason: "resource-busy" | "operation-id-conflict" = "resource-busy",
  ) {
    super(
      reason === "operation-id-conflict"
        ? "operationId 已用于不同的预览操作"
        : operationKind === "create"
          ? previewKind === "web"
            ? "已有网页预览正在创建"
            : "已有模拟器预览正在创建"
          : previewKind === "web"
            ? "该网页预览正在处理中"
            : "该模拟器预览正在处理中",
    );
    this.name = "PreviewOperationConflictError";
    this.previewKind = previewKind;
    this.operationKind = operationKind;
    this.previewId = previewId;
    this.reason = reason;
  }
}

interface ActivePreviewBinding {
  readonly relay: PreviewControllerRelay;
  readonly scope: PreviewScope;
  readonly abortController: AbortController;
}

interface SnapshotFlight<TResult> {
  readonly activation: ActivePreviewBinding;
  readonly sequence: number;
  readonly promise: Promise<TResult>;
}

type PreviewCreateAck =
  | Awaited<ReturnType<PreviewControllerRelay["createWebPreview"]>>
  | Awaited<ReturnType<PreviewControllerRelay["createDevicePreview"]>>;

type PreviewMutationAck =
  | Awaited<ReturnType<PreviewControllerRelay["renameWebPreview"]>>
  | Awaited<ReturnType<PreviewControllerRelay["reconnectWebPreview"]>>
  | Awaited<ReturnType<PreviewControllerRelay["closeWebPreview"]>>
  | Awaited<ReturnType<PreviewControllerRelay["renameDevicePreview"]>>
  | Awaited<ReturnType<PreviewControllerRelay["reconnectDevicePreview"]>>
  | Awaited<ReturnType<PreviewControllerRelay["closeDevicePreview"]>>;

type PreviewOperationAck = PreviewCreateAck | PreviewMutationAck;

interface PreviewOperationDescriptor {
  readonly previewKind: PreviewPendingResourceKind;
  readonly kind: PreviewPendingOperationKind;
  readonly previewId?: string;
  readonly fingerprint: string;
}

interface PreviewOperationFlight extends PreviewOperationDescriptor {
  readonly promise: Promise<PreviewOperationAck>;
}

function defaultReportBackgroundError(task: PreviewControllerBackgroundTask, error: unknown): void {
  if (error instanceof Error && error.name === "AbortError") return;
  console.error(`[preview-controller] ${task} failed`, error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedOperationName(name: string | undefined): string | null {
  return name === undefined ? null : name.trim();
}

function webCreateFingerprint(
  source: WebPreviewSourceInput,
  tunnelProvider: TunnelProvider,
  name: string | undefined,
): string {
  const sourceParameters =
    source.kind === "local"
      ? [source.kind, source.url]
      : [source.kind, source.path, source.entryPath];
  return JSON.stringify([sourceParameters, tunnelProvider, normalizedOperationName(name)]);
}

function deviceCreateFingerprint(targetId: string, name: string | undefined): string {
  return JSON.stringify([targetId, normalizedOperationName(name)]);
}

function renameFingerprint(name: string): string {
  return JSON.stringify([name.trim()]);
}

function sameOperation(
  operation: PreviewOperationDescriptor,
  candidate: PreviewOperationDescriptor,
): boolean {
  return (
    operation.previewKind === candidate.previewKind &&
    operation.kind === candidate.kind &&
    operation.previewId === candidate.previewId &&
    operation.fingerprint === candidate.fingerprint
  );
}

/**
 * Owns all preview control-plane work for exactly one Relay binding at a time.
 * Authoritative preview entities only enter the stores through versioned snapshots/events.
 */
export class PreviewController {
  private readonly createOperationId: (prefix: string) => string;
  private readonly now: () => number;
  private readonly reportBackgroundError: (
    task: PreviewControllerBackgroundTask,
    error: unknown,
  ) => void;

  private active: ActivePreviewBinding | null = null;
  private webSnapshotFlight: SnapshotFlight<WebPreviewReduceResult> | null = null;
  private deviceSnapshotFlight: SnapshotFlight<DevicePreviewReduceResult> | null = null;
  private webSnapshotSequence = 0;
  private deviceSnapshotSequence = 0;
  private webResyncRequested = false;
  private deviceResyncRequested = false;
  private webResyncAfterSequence: number | null = null;
  private deviceResyncAfterSequence: number | null = null;
  private webResyncRetryKey: string | null = null;
  private deviceResyncRetryKey: string | null = null;
  private webResyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private deviceResyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private webResyncRetryAttempt = 0;
  private deviceResyncRetryAttempt = 0;
  private readonly operationFlights = new Map<string, PreviewOperationFlight>();

  constructor(options: PreviewControllerOptions = {}) {
    this.createOperationId = options.createOperationId ?? createClientOperationId;
    this.now = options.now ?? Date.now;
    this.reportBackgroundError = options.reportBackgroundError ?? defaultReportBackgroundError;
  }

  activate(relay: PreviewControllerRelay, scope: PreviewScope): void {
    const relayScope = relay.getPreviewScope();
    if (!relayScope || !samePreviewScope(relayScope, scope)) {
      throw new PreviewScopeInactiveError(scope);
    }
    if (this.active?.relay === relay && samePreviewScope(this.active.scope, scope)) {
      return;
    }

    this.releaseActiveBinding();
    const frozenScope = createPreviewScope(scope.proxyId, scope.bindingId);
    this.active = {
      relay,
      scope: frozenScope,
      abortController: new AbortController(),
    };
    this.resetTransientState();
    usePreviewStore.getState().activateScope(frozenScope);
    useDevicePreviewStore.getState().activateScope(frozenScope);
  }

  deactivate(relay: PreviewControllerRelay, scope: PreviewScope): boolean {
    const active = this.active;
    if (!active || active.relay !== relay || !samePreviewScope(active.scope, scope)) {
      return false;
    }
    this.releaseActiveBinding();
    usePreviewStore.getState().clear();
    useDevicePreviewStore.getState().clear();
    return true;
  }

  dispose(): void {
    if (this.active) this.releaseActiveBinding();
    this.resetTransientState();
    this.operationFlights.clear();
    usePreviewOperationStore.getState().clear();
    usePreviewStore.getState().clear();
    useDevicePreviewStore.getState().clear();
  }

  getActiveScope(): PreviewScope | null {
    return this.active && this.isCurrent(this.active) ? this.active.scope : null;
  }

  isActive(relay: PreviewControllerRelay, scope: PreviewScope): boolean {
    const active = this.active;
    return (
      active !== null &&
      active.relay === relay &&
      samePreviewScope(active.scope, scope) &&
      this.isCurrent(active)
    );
  }

  syncWebSnapshot(scope: PreviewScope): Promise<WebPreviewReduceResult> {
    return this.startWebSnapshot(this.requireActive(scope));
  }

  syncDeviceSnapshot(scope: PreviewScope): Promise<DevicePreviewReduceResult> {
    return this.startDeviceSnapshot(this.requireActive(scope));
  }

  applyWebPreviewState(
    relay: PreviewControllerRelay,
    scope: PreviewScope,
    preview: PreviewSummary,
    epoch: string,
    revision: number,
  ): WebPreviewReduceResult {
    const active = this.currentForMessage(relay, scope);
    if (!active) return null;
    const store = usePreviewStore.getState();
    const result = store.applyPreviewState(active.scope, preview, epoch, revision);
    this.afterWebEvent(active, result);
    return result;
  }

  applyWebPreviewRemoved(
    relay: PreviewControllerRelay,
    scope: PreviewScope,
    previewId: string,
    epoch: string,
    revision: number,
  ): WebPreviewReduceResult {
    const active = this.currentForMessage(relay, scope);
    if (!active) return null;
    const store = usePreviewStore.getState();
    const result = store.applyPreviewRemoved(active.scope, previewId, epoch, revision);
    this.afterWebEvent(active, result);
    return result;
  }

  applyDevicePreviewState(
    relay: PreviewControllerRelay,
    scope: PreviewScope,
    preview: DevicePreviewSummary,
    epoch: string,
    revision: number,
  ): DevicePreviewReduceResult {
    const active = this.currentForMessage(relay, scope);
    if (!active) return null;
    const store = useDevicePreviewStore.getState();
    const result = store.applyPreviewState(active.scope, preview, epoch, revision);
    this.afterDeviceEvent(active, result);
    return result;
  }

  applyDevicePreviewRemoved(
    relay: PreviewControllerRelay,
    scope: PreviewScope,
    previewId: string,
    epoch: string,
    revision: number,
  ): DevicePreviewReduceResult {
    const active = this.currentForMessage(relay, scope);
    if (!active) return null;
    const store = useDevicePreviewStore.getState();
    const result = store.applyPreviewRemoved(active.scope, previewId, epoch, revision);
    this.afterDeviceEvent(active, result);
    return result;
  }

  handleMessage(relay: PreviewControllerRelay, message: InboundMessage): boolean {
    switch (message.type) {
      case "preview_state_push":
        return (
          this.applyWebPreviewState(
            relay,
            message.scope,
            message.preview,
            message.epoch,
            message.revision,
          ) !== null
        );
      case "preview_removed_push":
        return (
          this.applyWebPreviewRemoved(
            relay,
            message.scope,
            message.previewId,
            message.epoch,
            message.revision,
          ) !== null
        );
      case "device_preview_state_push":
        return (
          this.applyDevicePreviewState(
            relay,
            message.scope,
            message.preview,
            message.epoch,
            message.revision,
          ) !== null
        );
      case "device_preview_removed_push":
        return (
          this.applyDevicePreviewRemoved(
            relay,
            message.scope,
            message.previewId,
            message.epoch,
            message.revision,
          ) !== null
        );
      default:
        return false;
    }
  }

  async inspectStaticWebPreview(
    scope: PreviewScope,
    path: string,
    options: PreviewQueryRequestOptions = {},
  ): Promise<Awaited<ReturnType<PreviewControllerRelay["inspectStaticWebPreview"]>> | null> {
    const active = this.requireActive(scope);
    const signal = this.querySignal(active, options.signal);
    const result = await active.relay.inspectStaticWebPreview(active.scope, path, {
      timeoutMs: options.timeoutMs,
      signal,
    });
    signal.throwIfAborted();
    return this.isCurrent(active) ? result : null;
  }

  async requestWebPreviewCapability(
    scope: PreviewScope,
    refreshPath = false,
    options: PreviewQueryRequestOptions = {},
  ): Promise<Awaited<ReturnType<PreviewControllerRelay["requestWebPreviewCapability"]>> | null> {
    const active = this.requireActive(scope);
    const signal = this.querySignal(active, options.signal);
    usePreviewStore.getState().setCapabilityLoading(active.scope);
    try {
      const result = await active.relay.requestWebPreviewCapability(active.scope, refreshPath, {
        timeoutMs: options.timeoutMs,
        signal,
      });
      signal.throwIfAborted();
      if (!this.isCurrent(active)) return null;
      if (result.success) {
        usePreviewStore.getState().setCapability(active.scope, result.capability);
      } else {
        usePreviewStore.getState().setCapabilityError(active.scope, result.error);
      }
      return result;
    } catch (error) {
      if (this.isCurrent(active) && !options.signal?.aborted) {
        usePreviewStore.getState().setCapabilityError(active.scope, errorMessage(error));
      }
      throw error;
    }
  }

  async requestDevicePreviewCapability(
    scope: PreviewScope,
    refreshPath = false,
    options: PreviewQueryRequestOptions = {},
  ): Promise<Awaited<ReturnType<PreviewControllerRelay["requestDevicePreviewCapability"]>> | null> {
    const active = this.requireActive(scope);
    const signal = this.querySignal(active, options.signal);
    useDevicePreviewStore.getState().setCapabilityLoading(active.scope);
    try {
      const result = await active.relay.requestDevicePreviewCapability(active.scope, refreshPath, {
        timeoutMs: options.timeoutMs,
        signal,
      });
      signal.throwIfAborted();
      if (!this.isCurrent(active)) return null;
      if (result.success) {
        useDevicePreviewStore.getState().setCapability(active.scope, result.capability);
      } else {
        useDevicePreviewStore.getState().setCapabilityError(active.scope, result.error);
      }
      return result;
    } catch (error) {
      if (this.isCurrent(active) && !options.signal?.aborted) {
        useDevicePreviewStore.getState().setCapabilityError(active.scope, errorMessage(error));
      }
      throw error;
    }
  }

  async requestDevicePreviewTargets(
    scope: PreviewScope,
    refresh = false,
    options: PreviewQueryRequestOptions = {},
  ): Promise<Awaited<ReturnType<PreviewControllerRelay["requestDevicePreviewTargets"]>> | null> {
    const active = this.requireActive(scope);
    const signal = this.querySignal(active, options.signal);
    useDevicePreviewStore.getState().setTargetsLoading(active.scope);
    try {
      const result = await active.relay.requestDevicePreviewTargets(active.scope, refresh, {
        timeoutMs: options.timeoutMs,
        signal,
      });
      signal.throwIfAborted();
      if (!this.isCurrent(active)) return null;
      if (result.success) {
        useDevicePreviewStore.getState().setTargets(active.scope, result.targets);
      } else {
        useDevicePreviewStore.getState().setTargetsError(active.scope, result.error);
      }
      return result;
    } catch (error) {
      if (this.isCurrent(active) && !options.signal?.aborted) {
        useDevicePreviewStore.getState().setTargetsError(active.scope, errorMessage(error));
      }
      throw error;
    }
  }

  async requestDevicePreviewStream(
    scope: PreviewScope,
    previewId: string,
    profile: DevicePreviewStreamProfile,
    options: PreviewQueryRequestOptions = {},
  ): Promise<ScopedDevicePreviewStreamAccess | null> {
    const active = this.requireActive(scope);
    const signal = this.querySignal(active, options.signal);
    const result = await active.relay.requestDevicePreviewStream(active.scope, previewId, profile, {
      timeoutMs: options.timeoutMs,
      signal,
    });
    signal.throwIfAborted();
    if (!this.isCurrent(active)) return null;
    return Object.freeze({ ...result, scope: active.scope, signal });
  }

  async sendDevicePreviewInput(
    access: Pick<ActiveDevicePreviewStreamAccess, "scope" | "leaseId" | "signal">,
    input: DevicePreviewInput,
    options: PreviewQueryRequestOptions = {},
  ): Promise<Awaited<ReturnType<PreviewControllerRelay["sendDevicePreviewInput"]>> | null> {
    const active = this.requireActive(access.scope);
    const accessSignal = options.signal
      ? AbortSignal.any([access.signal, options.signal])
      : access.signal;
    const signal = this.querySignal(active, accessSignal);
    signal.throwIfAborted();
    const result = await active.relay.sendDevicePreviewInput(active.scope, access.leaseId, input, {
      timeoutMs: options.timeoutMs,
      signal,
    });
    signal.throwIfAborted();
    return this.isCurrent(active) ? result : null;
  }

  async claimDevicePreviewControl(
    access: Pick<ActiveDevicePreviewStreamAccess, "scope" | "leaseId" | "signal">,
    options: PreviewQueryRequestOptions = {},
  ): Promise<Awaited<ReturnType<PreviewControllerRelay["claimDevicePreviewControl"]>> | null> {
    const active = this.requireActive(access.scope);
    const accessSignal = options.signal
      ? AbortSignal.any([access.signal, options.signal])
      : access.signal;
    const signal = this.querySignal(active, accessSignal);
    signal.throwIfAborted();
    const result = await active.relay.claimDevicePreviewControl(active.scope, access.leaseId, {
      timeoutMs: options.timeoutMs,
      signal,
    });
    signal.throwIfAborted();
    return this.isCurrent(active) ? result : null;
  }

  createWebPreview(
    scope: PreviewScope,
    source: WebPreviewSourceInput,
    options: CreateWebPreviewOptions,
  ): ReturnType<PreviewControllerRelay["createWebPreview"]> {
    const operationId = options.operationId ?? this.createOperationId("web-preview-create");
    return this.runCreateOperation(
      scope,
      "web",
      operationId,
      webCreateFingerprint(source, options.tunnelProvider, options.name),
      options.timeoutMs,
      (active) =>
        active.relay.createWebPreview(active.scope, source, {
          tunnelProvider: options.tunnelProvider,
          name: options.name,
          operationId,
          timeoutMs: options.timeoutMs,
          signal: active.abortController.signal,
        }),
    );
  }

  renameWebPreview(
    scope: PreviewScope,
    previewId: string,
    name: string,
    options: PreviewOperationRequestOptions = {},
  ): ReturnType<PreviewControllerRelay["renameWebPreview"]> {
    const operationId = options.operationId ?? this.createOperationId("web-preview-rename");
    return this.runMutationOperation(
      scope,
      "web",
      "rename",
      previewId,
      operationId,
      renameFingerprint(name),
      (active) =>
        active.relay.renameWebPreview(active.scope, previewId, name, {
          operationId,
          timeoutMs: options.timeoutMs,
          signal: active.abortController.signal,
        }),
    );
  }

  reconnectWebPreview(
    scope: PreviewScope,
    previewId: string,
    options: PreviewOperationRequestOptions = {},
  ): ReturnType<PreviewControllerRelay["reconnectWebPreview"]> {
    const operationId = options.operationId ?? this.createOperationId("web-preview-reconnect");
    return this.runMutationOperation(
      scope,
      "web",
      "reconnect",
      previewId,
      operationId,
      "[]",
      (active) =>
        active.relay.reconnectWebPreview(active.scope, previewId, {
          operationId,
          timeoutMs: options.timeoutMs,
          signal: active.abortController.signal,
        }),
    );
  }

  closeWebPreview(
    scope: PreviewScope,
    previewId: string,
    options: PreviewOperationRequestOptions = {},
  ): ReturnType<PreviewControllerRelay["closeWebPreview"]> {
    const operationId = options.operationId ?? this.createOperationId("web-preview-close");
    return this.runMutationOperation(
      scope,
      "web",
      "close",
      previewId,
      operationId,
      "[]",
      (active) =>
        active.relay.closeWebPreview(active.scope, previewId, {
          operationId,
          timeoutMs: options.timeoutMs,
          signal: active.abortController.signal,
        }),
    );
  }

  createDevicePreview(
    scope: PreviewScope,
    targetId: string,
    options: CreateDevicePreviewOptions = {},
  ): ReturnType<PreviewControllerRelay["createDevicePreview"]> {
    const operationId = options.operationId ?? this.createOperationId("device-preview-create");
    return this.runCreateOperation(
      scope,
      "device",
      operationId,
      deviceCreateFingerprint(targetId, options.name),
      options.timeoutMs,
      (active) =>
        active.relay.createDevicePreview(active.scope, targetId, {
          name: options.name,
          operationId,
          timeoutMs: options.timeoutMs,
          signal: active.abortController.signal,
        }),
    );
  }

  renameDevicePreview(
    scope: PreviewScope,
    previewId: string,
    name: string,
    options: PreviewOperationRequestOptions = {},
  ): ReturnType<PreviewControllerRelay["renameDevicePreview"]> {
    const operationId = options.operationId ?? this.createOperationId("device-preview-rename");
    return this.runMutationOperation(
      scope,
      "device",
      "rename",
      previewId,
      operationId,
      renameFingerprint(name),
      (active) =>
        active.relay.renameDevicePreview(active.scope, previewId, name, {
          operationId,
          timeoutMs: options.timeoutMs,
          signal: active.abortController.signal,
        }),
    );
  }

  reconnectDevicePreview(
    scope: PreviewScope,
    previewId: string,
    options: PreviewOperationRequestOptions = {},
  ): ReturnType<PreviewControllerRelay["reconnectDevicePreview"]> {
    const operationId = options.operationId ?? this.createOperationId("device-preview-reconnect");
    return this.runMutationOperation(
      scope,
      "device",
      "reconnect",
      previewId,
      operationId,
      "[]",
      (active) =>
        active.relay.reconnectDevicePreview(active.scope, previewId, {
          operationId,
          timeoutMs: options.timeoutMs,
          signal: active.abortController.signal,
        }),
    );
  }

  closeDevicePreview(
    scope: PreviewScope,
    previewId: string,
    options: PreviewOperationRequestOptions = {},
  ): ReturnType<PreviewControllerRelay["closeDevicePreview"]> {
    const operationId = options.operationId ?? this.createOperationId("device-preview-close");
    return this.runMutationOperation(
      scope,
      "device",
      "close",
      previewId,
      operationId,
      "[]",
      (active) =>
        active.relay.closeDevicePreview(active.scope, previewId, {
          operationId,
          timeoutMs: options.timeoutMs,
          signal: active.abortController.signal,
        }),
    );
  }

  private requireActive(scope: PreviewScope): ActivePreviewBinding {
    const active = this.active;
    if (!active || !samePreviewScope(active.scope, scope) || !this.isCurrent(active)) {
      throw new PreviewScopeInactiveError(scope);
    }
    return active;
  }

  private querySignal(active: ActivePreviewBinding, callerSignal?: AbortSignal): AbortSignal {
    return callerSignal
      ? AbortSignal.any([active.abortController.signal, callerSignal])
      : active.abortController.signal;
  }

  private currentForMessage(
    relay: PreviewControllerRelay,
    scope: PreviewScope,
  ): ActivePreviewBinding | null {
    const active = this.active;
    return active &&
      active.relay === relay &&
      samePreviewScope(active.scope, scope) &&
      this.isCurrent(active)
      ? active
      : null;
  }

  private isCurrent(active: ActivePreviewBinding): boolean {
    if (this.active !== active || active.abortController.signal.aborted) return false;
    const relayScope = active.relay.getPreviewScope();
    return relayScope !== null && samePreviewScope(relayScope, active.scope);
  }

  private releaseActiveBinding(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.abortController.abort();
    usePreviewOperationStore.getState().clearScope(active.scope);
    this.resetTransientState();
  }

  private resetTransientState(): void {
    if (this.webResyncRetryTimer !== null) clearTimeout(this.webResyncRetryTimer);
    if (this.deviceResyncRetryTimer !== null) clearTimeout(this.deviceResyncRetryTimer);
    this.webSnapshotFlight = null;
    this.deviceSnapshotFlight = null;
    this.webResyncRequested = false;
    this.deviceResyncRequested = false;
    this.webResyncAfterSequence = null;
    this.deviceResyncAfterSequence = null;
    this.webResyncRetryKey = null;
    this.deviceResyncRetryKey = null;
    this.webResyncRetryTimer = null;
    this.deviceResyncRetryTimer = null;
    this.webResyncRetryAttempt = 0;
    this.deviceResyncRetryAttempt = 0;
  }

  private startWebSnapshot(
    active: ActivePreviewBinding,
    timeoutMs?: number,
  ): Promise<WebPreviewReduceResult> {
    const existing = this.webSnapshotFlight;
    if (existing?.activation === active) return existing.promise;

    usePreviewStore.getState().markListLoading(active.scope);
    const sequence = ++this.webSnapshotSequence;
    const promise = active.relay
      .requestWebPreviewList(active.scope, {
        signal: active.abortController.signal,
        timeoutMs,
      })
      .then((snapshot) => {
        active.abortController.signal.throwIfAborted();
        if (!this.isCurrent(active)) return null;
        const store = usePreviewStore.getState();
        const authoritative = store.authoritative;
        if (
          this.webResyncAfterSequence !== null &&
          sequence <= this.webResyncAfterSequence &&
          authoritative?.syncStatus === "needs-resync" &&
          samePreviewScope(authoritative.scope, active.scope)
        ) {
          return {
            status: "needs-resync" as const,
            reason: "resync-pending" as const,
            state: authoritative,
          };
        }
        return store.replaceSnapshot(active.scope, snapshot);
      });
    const flight: SnapshotFlight<WebPreviewReduceResult> = {
      activation: active,
      sequence,
      promise,
    };
    this.webSnapshotFlight = flight;
    void promise.then(
      () => this.finishWebSnapshot(flight),
      () => this.finishWebSnapshot(flight),
    );
    return promise;
  }

  private finishWebSnapshot(flight: SnapshotFlight<WebPreviewReduceResult>): void {
    if (this.webSnapshotFlight !== flight) return;
    this.webSnapshotFlight = null;
    if (this.webResyncRequested) this.drainWebResync(flight.activation);
  }

  private startDeviceSnapshot(
    active: ActivePreviewBinding,
    timeoutMs?: number,
  ): Promise<DevicePreviewReduceResult> {
    const existing = this.deviceSnapshotFlight;
    if (existing?.activation === active) return existing.promise;

    useDevicePreviewStore.getState().markListLoading(active.scope);
    const sequence = ++this.deviceSnapshotSequence;
    const promise = active.relay
      .requestDevicePreviewList(active.scope, {
        signal: active.abortController.signal,
        timeoutMs,
      })
      .then((snapshot) => {
        active.abortController.signal.throwIfAborted();
        if (!this.isCurrent(active)) return null;
        const store = useDevicePreviewStore.getState();
        const authoritative = store.authoritative;
        if (
          this.deviceResyncAfterSequence !== null &&
          sequence <= this.deviceResyncAfterSequence &&
          authoritative?.syncStatus === "needs-resync" &&
          samePreviewScope(authoritative.scope, active.scope)
        ) {
          return {
            status: "needs-resync" as const,
            reason: "resync-pending" as const,
            state: authoritative,
          };
        }
        return store.replaceSnapshot(active.scope, snapshot);
      });
    const flight: SnapshotFlight<DevicePreviewReduceResult> = {
      activation: active,
      sequence,
      promise,
    };
    this.deviceSnapshotFlight = flight;
    void promise.then(
      () => this.finishDeviceSnapshot(flight),
      () => this.finishDeviceSnapshot(flight),
    );
    return promise;
  }

  private finishDeviceSnapshot(flight: SnapshotFlight<DevicePreviewReduceResult>): void {
    if (this.deviceSnapshotFlight !== flight) return;
    this.deviceSnapshotFlight = null;
    if (this.deviceResyncRequested) this.drainDeviceResync(flight.activation);
  }

  private afterWebEvent(active: ActivePreviewBinding, result: WebPreviewReduceResult): void {
    if (result?.status === "needs-resync") {
      this.requestWebResync(active);
    }
  }

  private afterDeviceEvent(active: ActivePreviewBinding, result: DevicePreviewReduceResult): void {
    if (result?.status === "needs-resync") {
      this.requestDeviceResync(active);
    }
  }

  private requestWebResync(active: ActivePreviewBinding): void {
    if (!this.isCurrent(active)) return;
    if (this.webResyncRetryTimer !== null) {
      clearTimeout(this.webResyncRetryTimer);
      this.webResyncRetryTimer = null;
    }
    this.webResyncRequested = true;
    this.webResyncAfterSequence = Math.max(
      this.webResyncAfterSequence ?? -1,
      this.webSnapshotSequence,
    );
    queueMicrotask(() => this.drainWebResync(active));
  }

  private drainWebResync(active: ActivePreviewBinding): void {
    if (!this.isCurrent(active)) return;
    if (!this.webResyncRequested || this.webSnapshotFlight) return;
    const requiredAfterSequence = this.webResyncAfterSequence;
    const requiresPostEventSnapshot =
      requiredAfterSequence !== null && this.webSnapshotSequence <= requiredAfterSequence;
    if (
      usePreviewStore.getState().authoritative?.syncStatus !== "needs-resync" &&
      !requiresPostEventSnapshot
    ) {
      this.webResyncRequested = false;
      this.webResyncAfterSequence = null;
      this.webResyncRetryKey = null;
      this.webResyncRetryAttempt = 0;
      return;
    }

    this.webResyncRequested = false;
    const snapshot = this.startWebSnapshot(active);
    const snapshotSequence = this.webSnapshotSequence;
    void snapshot.then(
      (result) => {
        if (!this.isCurrent(active)) return;
        if (result?.status !== "needs-resync") {
          if (
            this.webResyncAfterSequence !== null &&
            this.webResyncAfterSequence < snapshotSequence
          ) {
            this.webResyncAfterSequence = null;
          }
          this.webResyncRetryKey = null;
          this.webResyncRetryAttempt = 0;
          return;
        }
        const cause = result.state.resyncCause;
        const retryKey = `${cause.observedEpoch}\u0000${cause.observedRevision}`;
        const repeatedResult = this.webResyncRetryKey === retryKey;
        this.webResyncRetryKey = retryKey;
        this.webResyncAfterSequence = Math.max(this.webResyncAfterSequence ?? -1, snapshotSequence);
        if (this.webSnapshotFlight) return;
        if (repeatedResult) this.scheduleWebResyncRetry(active);
        else this.requestWebResync(active);
      },
      (error: unknown) => {
        if (!this.isCurrent(active)) return;
        this.webResyncAfterSequence = Math.max(this.webResyncAfterSequence ?? -1, snapshotSequence);
        this.reportBackgroundError("web-resync", error);
        this.scheduleWebResyncRetry(active);
      },
    );
  }

  private scheduleWebResyncRetry(active: ActivePreviewBinding): void {
    if (!this.isCurrent(active) || this.webResyncRetryTimer !== null) return;
    const delay = Math.min(
      RESYNC_RETRY_BASE_DELAY_MS * 2 ** this.webResyncRetryAttempt,
      RESYNC_RETRY_MAX_DELAY_MS,
    );
    this.webResyncRetryAttempt += 1;
    this.webResyncRetryTimer = setTimeout(() => {
      this.webResyncRetryTimer = null;
      this.requestWebResync(active);
    }, delay);
  }

  private requestDeviceResync(active: ActivePreviewBinding): void {
    if (!this.isCurrent(active)) return;
    if (this.deviceResyncRetryTimer !== null) {
      clearTimeout(this.deviceResyncRetryTimer);
      this.deviceResyncRetryTimer = null;
    }
    this.deviceResyncRequested = true;
    this.deviceResyncAfterSequence = Math.max(
      this.deviceResyncAfterSequence ?? -1,
      this.deviceSnapshotSequence,
    );
    queueMicrotask(() => this.drainDeviceResync(active));
  }

  private drainDeviceResync(active: ActivePreviewBinding): void {
    if (!this.isCurrent(active)) return;
    if (!this.deviceResyncRequested || this.deviceSnapshotFlight) return;
    const requiredAfterSequence = this.deviceResyncAfterSequence;
    const requiresPostEventSnapshot =
      requiredAfterSequence !== null && this.deviceSnapshotSequence <= requiredAfterSequence;
    if (
      useDevicePreviewStore.getState().authoritative?.syncStatus !== "needs-resync" &&
      !requiresPostEventSnapshot
    ) {
      this.deviceResyncRequested = false;
      this.deviceResyncAfterSequence = null;
      this.deviceResyncRetryKey = null;
      this.deviceResyncRetryAttempt = 0;
      return;
    }

    this.deviceResyncRequested = false;
    const snapshot = this.startDeviceSnapshot(active);
    const snapshotSequence = this.deviceSnapshotSequence;
    void snapshot.then(
      (result) => {
        if (!this.isCurrent(active)) return;
        if (result?.status !== "needs-resync") {
          if (
            this.deviceResyncAfterSequence !== null &&
            this.deviceResyncAfterSequence < snapshotSequence
          ) {
            this.deviceResyncAfterSequence = null;
          }
          this.deviceResyncRetryKey = null;
          this.deviceResyncRetryAttempt = 0;
          return;
        }
        const cause = result.state.resyncCause;
        const retryKey = `${cause.observedEpoch}\u0000${cause.observedRevision}`;
        const repeatedResult = this.deviceResyncRetryKey === retryKey;
        this.deviceResyncRetryKey = retryKey;
        this.deviceResyncAfterSequence = Math.max(
          this.deviceResyncAfterSequence ?? -1,
          snapshotSequence,
        );
        if (this.deviceSnapshotFlight) return;
        if (repeatedResult) this.scheduleDeviceResyncRetry(active);
        else this.requestDeviceResync(active);
      },
      (error: unknown) => {
        if (!this.isCurrent(active)) return;
        this.deviceResyncAfterSequence = Math.max(
          this.deviceResyncAfterSequence ?? -1,
          snapshotSequence,
        );
        this.reportBackgroundError("device-resync", error);
        this.scheduleDeviceResyncRetry(active);
      },
    );
  }

  private scheduleDeviceResyncRetry(active: ActivePreviewBinding): void {
    if (!this.isCurrent(active) || this.deviceResyncRetryTimer !== null) return;
    const delay = Math.min(
      RESYNC_RETRY_BASE_DELAY_MS * 2 ** this.deviceResyncRetryAttempt,
      RESYNC_RETRY_MAX_DELAY_MS,
    );
    this.deviceResyncRetryAttempt += 1;
    this.deviceResyncRetryTimer = setTimeout(() => {
      this.deviceResyncRetryTimer = null;
      this.requestDeviceResync(active);
    }, delay);
  }

  private operationKey(scope: PreviewScope, operationId: string): string {
    return `${scope.proxyId}\u0000${scope.bindingId}\u0000${operationId}`;
  }

  private runCreateOperation<TResult extends PreviewCreateAck>(
    scope: PreviewScope,
    previewKind: PreviewPendingResourceKind,
    operationId: string,
    fingerprint: string,
    timeoutMs: number | undefined,
    invoke: (active: ActivePreviewBinding) => Promise<TResult>,
  ): Promise<TResult> {
    return this.trackOperation(
      scope,
      previewKind,
      "create",
      undefined,
      operationId,
      fingerprint,
      (active) => this.executeCreateOperation(active, previewKind, operationId, timeoutMs, invoke),
    );
  }

  private runMutationOperation<TResult extends PreviewMutationAck>(
    scope: PreviewScope,
    previewKind: PreviewPendingResourceKind,
    operationKind: Exclude<PreviewPendingOperationKind, "create">,
    previewId: string,
    operationId: string,
    fingerprint: string,
    invoke: (active: ActivePreviewBinding) => Promise<TResult>,
  ): Promise<TResult> {
    return this.trackOperation(
      scope,
      previewKind,
      operationKind,
      previewId,
      operationId,
      fingerprint,
      (active) => this.executeMutationOperation(active, previewKind, operationId, invoke),
    );
  }

  private trackOperation<TResult extends PreviewOperationAck>(
    scope: PreviewScope,
    previewKind: PreviewPendingResourceKind,
    operationKind: PreviewPendingOperationKind,
    previewId: string | undefined,
    operationId: string,
    fingerprint: string,
    execute: (active: ActivePreviewBinding) => Promise<TResult>,
  ): Promise<TResult> {
    let active: ActivePreviewBinding;
    try {
      active = this.requireActive(scope);
    } catch (error) {
      return Promise.reject(error);
    }

    const operation: PreviewPendingOperation = {
      kind: operationKind,
      previewKind,
      operationId,
      fingerprint,
      scope: active.scope,
      ...(operationKind === "create" ? {} : { previewId: previewId! }),
      startedAt: this.now(),
    } as PreviewPendingOperation;
    const descriptor: PreviewOperationDescriptor = {
      previewKind,
      kind: operationKind,
      ...(previewId === undefined ? {} : { previewId }),
      fingerprint,
    };
    const key = this.operationKey(active.scope, operationId);
    const existingFlight = this.operationFlights.get(key);
    if (existingFlight) {
      if (sameOperation(existingFlight, descriptor)) {
        return existingFlight.promise as Promise<TResult>;
      }
      return Promise.reject(
        new PreviewOperationConflictError(
          previewKind,
          operationKind,
          previewId,
          "operation-id-conflict",
        ),
      );
    }

    const operationStore = usePreviewOperationStore.getState();
    const pendingWithSameId = findPreviewPendingOperation(
      operationStore.registry,
      active.scope,
      operationId,
    );
    if (pendingWithSameId) {
      return Promise.reject(
        new PreviewOperationConflictError(
          previewKind,
          operationKind,
          previewId,
          sameOperation(pendingWithSameId, descriptor) ? "resource-busy" : "operation-id-conflict",
        ),
      );
    }
    const overlaps =
      operationKind === "create"
        ? listPreviewPendingOperations(operationStore.registry, active.scope, previewKind).some(
            (operation) => operation.kind === "create",
          )
        : listPreviewPendingOperationsForPreview(
            operationStore.registry,
            active.scope,
            previewKind,
            previewId!,
          ).length > 0;
    if (overlaps) {
      return Promise.reject(
        new PreviewOperationConflictError(previewKind, operationKind, previewId),
      );
    }

    const registration = operationStore.begin(operation);
    if (registration.status !== "applied") {
      return Promise.reject(
        new PreviewOperationConflictError(
          previewKind,
          operationKind,
          previewId,
          registration.status === "conflict" ? "operation-id-conflict" : "resource-busy",
        ),
      );
    }

    const execution = execute(active);
    const tracked = execution.finally(() => this.operationFlights.delete(key));
    this.operationFlights.set(key, {
      ...descriptor,
      promise: tracked as Promise<PreviewOperationAck>,
    });
    return tracked;
  }

  private async executeMutationOperation<TResult extends PreviewMutationAck>(
    active: ActivePreviewBinding,
    previewKind: PreviewPendingResourceKind,
    operationId: string,
    invoke: (active: ActivePreviewBinding) => Promise<TResult>,
  ): Promise<TResult> {
    let ack: TResult;
    try {
      ack = await invoke(active);
      active.abortController.signal.throwIfAborted();
    } catch (operationError) {
      usePreviewOperationStore.getState().finish(active.scope, operationId);
      void this.reconcileAfterOperation(active, previewKind);
      throw operationError;
    }

    // An ACK only closes the local pending command. Snapshot/event state remains authoritative.
    usePreviewOperationStore.getState().finish(active.scope, operationId);
    void this.reconcileAfterOperation(active, previewKind);
    return ack;
  }

  private async executeCreateOperation<TResult extends PreviewCreateAck>(
    active: ActivePreviewBinding,
    previewKind: PreviewPendingResourceKind,
    operationId: string,
    timeoutMs: number | undefined,
    invoke: (active: ActivePreviewBinding) => Promise<TResult>,
  ): Promise<TResult> {
    let ack: TResult;
    try {
      ack = await invoke(active);
      this.assertCurrentBinding(active);
    } catch (operationError) {
      usePreviewOperationStore.getState().finish(active.scope, operationId);
      void this.reconcileAfterOperation(active, previewKind, timeoutMs);
      throw operationError;
    }

    if (!ack.accepted) {
      usePreviewOperationStore.getState().finish(active.scope, operationId);
      return ack;
    }

    try {
      await this.confirmCreatedPreview(active, previewKind, ack.previewId, timeoutMs);
      return ack;
    } catch (confirmationError) {
      void this.reconcileAfterOperation(active, previewKind, timeoutMs);
      throw confirmationError;
    } finally {
      usePreviewOperationStore.getState().finish(active.scope, operationId);
    }
  }

  private async confirmCreatedPreview(
    active: ActivePreviewBinding,
    previewKind: PreviewPendingResourceKind,
    previewId: string,
    timeoutMs: number | undefined,
  ): Promise<void> {
    this.assertCurrentBinding(active);
    if (this.hasAuthoritativePreview(active, previewKind, previewId)) return;

    let result: WebPreviewReduceResult | DevicePreviewReduceResult;
    try {
      result =
        previewKind === "web"
          ? await this.ensureWebSnapshotAfterCurrentFlight(active, timeoutMs)
          : await this.ensureDeviceSnapshotAfterCurrentFlight(active, timeoutMs);
    } catch (snapshotError) {
      this.assertCurrentBinding(active);
      throw new PreviewCreateConfirmationError(previewKind, previewId, snapshotError);
    }

    this.assertCurrentBinding(active);
    if (this.hasAuthoritativePreview(active, previewKind, previewId)) return;
    if (result?.status === "needs-resync") {
      if (previewKind === "web") this.requestWebResync(active);
      else this.requestDeviceResync(active);
    }
    throw new PreviewCreateConfirmationError(previewKind, previewId);
  }

  private assertCurrentBinding(active: ActivePreviewBinding): void {
    active.abortController.signal.throwIfAborted();
    if (!this.isCurrent(active)) throw new PreviewScopeInactiveError(active.scope);
  }

  private hasAuthoritativePreview(
    active: ActivePreviewBinding,
    previewKind: PreviewPendingResourceKind,
    previewId: string,
  ): boolean {
    const authoritative =
      previewKind === "web"
        ? usePreviewStore.getState().authoritative
        : useDevicePreviewStore.getState().authoritative;
    return (
      authoritative !== null &&
      samePreviewScope(authoritative.scope, active.scope) &&
      authoritative.previews.some((preview) => preview.previewId === previewId)
    );
  }

  private async reconcileAfterOperation(
    active: ActivePreviewBinding,
    previewKind: PreviewPendingResourceKind,
    timeoutMs?: number,
  ): Promise<void> {
    if (!this.isCurrent(active)) return;
    try {
      const result =
        previewKind === "web"
          ? await this.ensureWebSnapshotAfterCurrentFlight(active, timeoutMs)
          : await this.ensureDeviceSnapshotAfterCurrentFlight(active, timeoutMs);
      if (result?.status === "needs-resync") {
        if (previewKind === "web") this.requestWebResync(active);
        else this.requestDeviceResync(active);
      }
    } catch (error) {
      this.reportBackgroundError(
        previewKind === "web" ? "web-reconciliation" : "device-reconciliation",
        error,
      );
    }
  }

  private async ensureWebSnapshotAfterCurrentFlight(
    active: ActivePreviewBinding,
    timeoutMs?: number,
  ): Promise<WebPreviewReduceResult> {
    const minimumSequence = this.webSnapshotSequence + 1;
    while (this.isCurrent(active)) {
      const flight = this.webSnapshotFlight;
      if (!flight) return this.startWebSnapshot(active, timeoutMs);
      if (flight.sequence >= minimumSequence) return flight.promise;
      try {
        await flight.promise;
      } catch {
        // The operation still requires one snapshot attempt that started after its ACK/failure.
      }
    }
    return null;
  }

  private async ensureDeviceSnapshotAfterCurrentFlight(
    active: ActivePreviewBinding,
    timeoutMs?: number,
  ): Promise<DevicePreviewReduceResult> {
    const minimumSequence = this.deviceSnapshotSequence + 1;
    while (this.isCurrent(active)) {
      const flight = this.deviceSnapshotFlight;
      if (!flight) return this.startDeviceSnapshot(active, timeoutMs);
      if (flight.sequence >= minimumSequence) return flight.promise;
      try {
        await flight.promise;
      } catch {
        // The operation still requires one snapshot attempt that started after its ACK/failure.
      }
    }
    return null;
  }
}

/** Shared by Relay setup, preview dispatch, and every preview UI entry point. */
export const previewController = new PreviewController();
