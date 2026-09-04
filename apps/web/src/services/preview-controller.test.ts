import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DevicePreviewCapability,
  DevicePreviewSummary,
  PreviewSummary,
  WebPreviewCapability,
} from "@dev-anywhere/shared";
import {
  PreviewCreateConfirmationError,
  PreviewController,
  PreviewOperationConflictError,
  type PreviewControllerRelay,
} from "./preview-controller";
import { createPreviewScope, type PreviewScope } from "./preview-scope";
import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { usePreviewOperationStore } from "@/stores/preview-operation-store";
import { usePreviewStore } from "@/stores/preview-store";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function webPreview(previewId: string, state: PreviewSummary["state"] = "ready"): PreviewSummary {
  const common = {
    previewId,
    name: previewId,
    source: { kind: "local" as const, url: "http://localhost:5173" },
    tunnelProvider: "cloudflare" as const,
    createdAt: 1,
    updatedAt: state === "ready" ? 1 : 2,
  };
  if (state === "ready") {
    return { ...common, state, publicUrl: `https://${previewId}.trycloudflare.com` };
  }
  if (state === "failed") return { ...common, state, error: "preview failed" };
  return { ...common, state };
}

function devicePreview(previewId: string): DevicePreviewSummary {
  return {
    previewId,
    name: previewId,
    platform: "ios",
    targetId: "target-1",
    model: "iPhone 17 Pro",
    osVersion: "26.4",
    state: "ready",
    interactive: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createFakeRelay(initialScope: PreviewScope) {
  let currentScope: PreviewScope | null = initialScope;
  const api = {
    getPreviewScope: vi.fn<PreviewControllerRelay["getPreviewScope"]>(() => currentScope),
    inspectStaticWebPreview: vi.fn<PreviewControllerRelay["inspectStaticWebPreview"]>(async () => ({
      success: true,
      entryPath: "index.html",
      htmlEntries: ["index.html"],
    })),
    requestWebPreviewCapability: vi.fn<PreviewControllerRelay["requestWebPreviewCapability"]>(
      async () => ({
        success: false,
        error: "not configured",
        errorCode: "UNKNOWN",
      }),
    ),
    createWebPreview: vi.fn<PreviewControllerRelay["createWebPreview"]>(
      async (_scope, _source, options) => ({
        operationId: options.operationId,
        accepted: true,
        previewId: "web-created",
      }),
    ),
    requestWebPreviewList: vi.fn<PreviewControllerRelay["requestWebPreviewList"]>(async () => ({
      epoch: "web-epoch",
      revision: 0,
      previews: [] as PreviewSummary[],
    })),
    renameWebPreview: vi.fn<PreviewControllerRelay["renameWebPreview"]>(
      async (_scope, previewId, _name, options) => ({
        operationId: options.operationId,
        previewId,
        success: true,
      }),
    ),
    reconnectWebPreview: vi.fn<PreviewControllerRelay["reconnectWebPreview"]>(
      async (_scope, previewId, options) => ({
        operationId: options.operationId,
        previewId,
        success: true,
      }),
    ),
    closeWebPreview: vi.fn<PreviewControllerRelay["closeWebPreview"]>(
      async (_scope, previewId, options) => ({
        operationId: options.operationId,
        previewId,
        success: true,
      }),
    ),
    requestDevicePreviewCapability: vi.fn<PreviewControllerRelay["requestDevicePreviewCapability"]>(
      async () => ({
        success: false,
        error: "not configured",
        errorCode: "UNKNOWN",
      }),
    ),
    requestDevicePreviewTargets: vi.fn<PreviewControllerRelay["requestDevicePreviewTargets"]>(
      async () => ({
        success: true,
        targets: [],
      }),
    ),
    requestDevicePreviewStream: vi.fn<PreviewControllerRelay["requestDevicePreviewStream"]>(
      async () => ({
        previewId: "device-1",
        success: true,
        url: "/api/device-preview-streams/token-1",
        leaseId: "lease-1",
        expiresAt: 1_000,
        controlMode: "controller",
      }),
    ),
    sendDevicePreviewInput: vi.fn<PreviewControllerRelay["sendDevicePreviewInput"]>(
      async (_scope, leaseId, _input) => ({
        leaseId,
        inputSeq: 1,
        success: true,
      }),
    ),
    claimDevicePreviewControl: vi.fn<PreviewControllerRelay["claimDevicePreviewControl"]>(
      async () => ({ success: true, controlMode: "controller" }),
    ),
    createDevicePreview: vi.fn<PreviewControllerRelay["createDevicePreview"]>(
      async (_scope, _targetId, options) => ({
        operationId: options.operationId,
        accepted: true,
        previewId: "device-created",
      }),
    ),
    requestDevicePreviewList: vi.fn<PreviewControllerRelay["requestDevicePreviewList"]>(
      async () => ({
        epoch: "device-epoch",
        revision: 0,
        previews: [] as DevicePreviewSummary[],
      }),
    ),
    renameDevicePreview: vi.fn<PreviewControllerRelay["renameDevicePreview"]>(
      async (_scope, previewId, _name, options) => ({
        operationId: options.operationId,
        previewId,
        success: true,
      }),
    ),
    reconnectDevicePreview: vi.fn<PreviewControllerRelay["reconnectDevicePreview"]>(
      async (_scope, previewId, options) => ({
        operationId: options.operationId,
        previewId,
        success: true,
      }),
    ),
    closeDevicePreview: vi.fn<PreviewControllerRelay["closeDevicePreview"]>(
      async (_scope, previewId, options) => ({
        operationId: options.operationId,
        previewId,
        success: true,
      }),
    ),
  } satisfies PreviewControllerRelay;
  return {
    api,
    relay: api,
    setScope: (scope: PreviewScope | null) => {
      currentScope = scope;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function rejectWhenAborted<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (!signal) {
      reject(new Error("missing AbortSignal"));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

beforeEach(() => {
  usePreviewStore.getState().clear();
  useDevicePreviewStore.getState().clear();
  usePreviewOperationStore.getState().clear();
});

describe("PreviewController binding lifecycle", () => {
  it("aborts all old-scope work, clears pending operations, and rejects stale results", async () => {
    const scopeA = createPreviewScope("proxy-a", "binding-a");
    const scopeB = createPreviewScope("proxy-b", "binding-b");
    const relayA = createFakeRelay(scopeA);
    const relayB = createFakeRelay(scopeB);
    const inspectRequest = deferred<{
      success: true;
      entryPath: string;
      htmlEntries: string[];
    }>();
    const closeRequest = deferred<{
      operationId: string;
      previewId: string;
      success: true;
    }>();
    relayA.api.inspectStaticWebPreview.mockReturnValue(inspectRequest.promise);
    relayA.api.closeWebPreview.mockReturnValue(closeRequest.promise);

    const controller = new PreviewController();
    controller.activate(relayA.relay, scopeA);
    const inspection = controller.inspectStaticWebPreview(scopeA, "/site");
    const close = controller.closeWebPreview(scopeA, "preview-1", {
      operationId: "close-a",
    });
    const inspectSignal = relayA.api.inspectStaticWebPreview.mock.calls[0]?.[2]?.signal;
    const closeSignal = relayA.api.closeWebPreview.mock.calls[0]?.[2]?.signal;
    expect(usePreviewOperationStore.getState().registry.operations).toHaveLength(1);

    controller.activate(relayB.relay, scopeB);
    expect(inspectSignal?.aborted).toBe(true);
    expect(closeSignal?.aborted).toBe(true);
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
    expect(usePreviewStore.getState().authoritative?.scope).toEqual(scopeB);
    expect(useDevicePreviewStore.getState().authoritative?.scope).toEqual(scopeB);

    inspectRequest.resolve({
      success: true,
      entryPath: "index.html",
      htmlEntries: ["index.html"],
    });
    closeRequest.resolve({ operationId: "close-a", previewId: "preview-1", success: true });
    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
    await expect(close).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.deactivate(relayA.relay, scopeA)).toBe(false);
    expect(controller.deactivate(relayB.relay, scopeB)).toBe(true);
  });

  it("requires the activated Relay instance to own the Relay-issued scope", () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const otherScope = createPreviewScope("proxy-a", "binding-new");
    const relay = createFakeRelay(otherScope);
    const controller = new PreviewController();

    expect(() => controller.activate(relay.relay, scope)).toThrow("预览上下文已失效");
  });

  it("rejects a push stamped for an obsolete binding of the same Proxy", () => {
    const oldScope = createPreviewScope("proxy-a", "binding-a-1");
    const scope = createPreviewScope("proxy-a", "binding-a-2");
    const fake = createFakeRelay(scope);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    usePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "web-epoch",
      revision: 1,
      previews: [webPreview("current")],
    });

    expect(
      controller.handleMessage(fake.relay, {
        type: "preview_state_push",
        scope: oldScope,
        epoch: "web-epoch",
        revision: 2,
        preview: webPreview("stale"),
      }),
    ).toBe(false);
    expect(usePreviewStore.getState().authoritative?.previews).toEqual([
      expect.objectContaining({ previewId: "current" }),
    ]);

    expect(
      controller.handleMessage(fake.relay, {
        type: "preview_state_push",
        scope,
        epoch: "web-epoch",
        revision: 2,
        preview: webPreview("current", "failed"),
      }),
    ).toBe(true);
    expect(usePreviewStore.getState().authoritative?.previews).toEqual([
      expect.objectContaining({ previewId: "current", state: "failed" }),
    ]);
  });

  it("does not let queued resync work from an old binding cancel the new binding", async () => {
    const oldScope = createPreviewScope("proxy-a", "binding-old");
    const newScope = createPreviewScope("proxy-b", "binding-new");
    const oldRelay = createFakeRelay(oldScope);
    const newRelay = createFakeRelay(newScope);
    const controller = new PreviewController();

    controller.activate(oldRelay.relay, oldScope);
    controller.applyWebPreviewState(
      oldRelay.relay,
      oldScope,
      webPreview("old-web"),
      "old-web-epoch",
      1,
    );
    controller.applyDevicePreviewState(
      oldRelay.relay,
      oldScope,
      devicePreview("old-device"),
      "old-device-epoch",
      1,
    );

    controller.activate(newRelay.relay, newScope);
    controller.applyWebPreviewState(
      newRelay.relay,
      newScope,
      webPreview("new-web"),
      "new-web-epoch",
      1,
    );
    controller.applyDevicePreviewState(
      newRelay.relay,
      newScope,
      devicePreview("new-device"),
      "new-device-epoch",
      1,
    );
    await flushMicrotasks();

    expect(oldRelay.api.requestWebPreviewList).not.toHaveBeenCalled();
    expect(oldRelay.api.requestDevicePreviewList).not.toHaveBeenCalled();
    expect(newRelay.api.requestWebPreviewList).toHaveBeenCalledTimes(1);
    expect(newRelay.api.requestDevicePreviewList).toHaveBeenCalledTimes(1);
  });

  it("globally clears stores and pending registry when disposed without an active binding", () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    usePreviewStore.getState().activateScope(scope);
    useDevicePreviewStore.getState().activateScope(scope);
    usePreviewOperationStore.getState().begin({
      kind: "create",
      previewKind: "web",
      operationId: "orphaned-operation",
      fingerprint: "orphaned-create",
      scope,
      startedAt: 1,
    });

    new PreviewController().dispose();

    expect(usePreviewStore.getState().authoritative).toBeNull();
    expect(useDevicePreviewStore.getState().authoritative).toBeNull();
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
  });
});

describe("PreviewController snapshots and events", () => {
  it("single-flights Web and Device snapshots independently", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const webRequest = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    const deviceRequest = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    fake.api.requestWebPreviewList.mockReturnValue(webRequest.promise);
    fake.api.requestDevicePreviewList.mockReturnValue(deviceRequest.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    const webOne = controller.syncWebSnapshot(scope);
    const webTwo = controller.syncWebSnapshot(scope);
    const deviceOne = controller.syncDeviceSnapshot(scope);
    const deviceTwo = controller.syncDeviceSnapshot(scope);
    expect(webOne).toBe(webTwo);
    expect(deviceOne).toBe(deviceTwo);
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(1);
    expect(fake.api.requestDevicePreviewList).toHaveBeenCalledTimes(1);

    webRequest.resolve({ epoch: "web-epoch", revision: 1, previews: [webPreview("web-1")] });
    deviceRequest.resolve({
      epoch: "device-epoch",
      revision: 1,
      previews: [devicePreview("device-1")],
    });
    await Promise.all([webOne, deviceOne]);
    expect(usePreviewStore.getState().authoritative?.previews[0]?.previewId).toBe("web-1");
    expect(useDevicePreviewStore.getState().authoritative?.previews[0]?.previewId).toBe("device-1");
  });

  it("coalesces unknown/gapped events and retries once when the first snapshot is behind", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const first = deferred<{ epoch: string; revision: number; previews: PreviewSummary[] }>();
    const second = deferred<{ epoch: string; revision: number; previews: PreviewSummary[] }>();
    fake.api.requestWebPreviewList
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const reportError = vi.fn();
    const controller = new PreviewController({ reportBackgroundError: reportError });
    controller.activate(fake.relay, scope);

    expect(
      controller.applyWebPreviewState(fake.relay, scope, webPreview("one"), "epoch-a", 1),
    ).toMatchObject({ status: "needs-resync", reason: "unknown-epoch" });
    controller.applyWebPreviewState(fake.relay, scope, webPreview("two"), "epoch-a", 2);
    await flushMicrotasks();
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(1);

    first.resolve({ epoch: "epoch-a", revision: 1, previews: [webPreview("one")] });
    await flushMicrotasks();
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(2);
    expect(usePreviewStore.getState().authoritative).toMatchObject({
      syncStatus: "needs-resync",
      previews: [],
    });

    second.resolve({
      epoch: "epoch-a",
      revision: 2,
      previews: [webPreview("one"), webPreview("two")],
    });
    await flushMicrotasks();
    expect(usePreviewStore.getState().authoritative).toMatchObject({
      syncStatus: "synchronized",
      revision: 2,
      previews: [
        expect.objectContaining({ previewId: "one" }),
        expect.objectContaining({ previewId: "two" }),
      ],
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("requests a post-event Web snapshot when a new epoch arrives during an old snapshot", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const oldSnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    const newSnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    fake.api.requestWebPreviewList
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockReturnValueOnce(newSnapshot.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    const initialSync = controller.syncWebSnapshot(scope);
    expect(
      controller.applyWebPreviewState(fake.relay, scope, webPreview("epoch-b-event"), "epoch-b", 1),
    ).toMatchObject({ status: "needs-resync", reason: "unknown-epoch" });

    oldSnapshot.resolve({
      epoch: "epoch-a",
      revision: 20,
      previews: [webPreview("epoch-a")],
    });
    await initialSync;
    await flushMicrotasks();
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(2);

    newSnapshot.resolve({
      epoch: "epoch-b",
      revision: 1,
      previews: [webPreview("epoch-b")],
    });
    await flushMicrotasks();
    expect(usePreviewStore.getState().authoritative).toMatchObject({
      syncStatus: "synchronized",
      epoch: "epoch-b",
      revision: 1,
      previews: [expect.objectContaining({ previewId: "epoch-b" })],
    });
  });

  it("keeps the Web resync latch until a post-event snapshot succeeds", async () => {
    vi.useFakeTimers();
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const oldSnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    const failedRecovery = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    const successfulRecovery = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    fake.api.requestWebPreviewList
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockReturnValueOnce(failedRecovery.promise)
      .mockReturnValueOnce(successfulRecovery.promise);
    const reportError = vi.fn();
    const controller = new PreviewController({ reportBackgroundError: reportError });

    try {
      controller.activate(fake.relay, scope);
      const initialSync = controller.syncWebSnapshot(scope);
      controller.applyWebPreviewState(fake.relay, scope, webPreview("epoch-b-event"), "epoch-b", 1);

      oldSnapshot.resolve({
        epoch: "epoch-a",
        revision: 20,
        previews: [webPreview("stale-epoch-a")],
      });
      await initialSync;
      await flushMicrotasks();
      expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(2);
      expect(usePreviewStore.getState().authoritative).toMatchObject({
        syncStatus: "needs-resync",
        previews: [],
      });

      failedRecovery.reject(new Error("snapshot unavailable"));
      await flushMicrotasks();
      expect(reportError).toHaveBeenCalledWith("web-resync", expect.any(Error));
      expect(usePreviewStore.getState().authoritative?.syncStatus).toBe("needs-resync");

      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(3);

      successfulRecovery.resolve({
        epoch: "epoch-b",
        revision: 1,
        previews: [webPreview("epoch-b")],
      });
      await flushMicrotasks();
      expect(usePreviewStore.getState().authoritative).toMatchObject({
        syncStatus: "synchronized",
        epoch: "epoch-b",
        revision: 1,
        previews: [expect.objectContaining({ previewId: "epoch-b" })],
      });
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("requests a second Web snapshot when a late old-epoch event arrives during a current flight", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const currentSnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    const recoverySnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    fake.api.requestWebPreviewList
      .mockReturnValueOnce(currentSnapshot.promise)
      .mockReturnValueOnce(recoverySnapshot.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    usePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "epoch-b",
      revision: 1,
      previews: [webPreview("epoch-b")],
    });

    const inFlightSync = controller.syncWebSnapshot(scope);
    expect(
      controller.applyWebPreviewState(fake.relay, scope, webPreview("late-a"), "epoch-a", 99),
    ).toMatchObject({ status: "needs-resync", reason: "unknown-epoch" });
    currentSnapshot.resolve({
      epoch: "epoch-b",
      revision: 2,
      previews: [webPreview("epoch-b")],
    });
    await inFlightSync;
    await flushMicrotasks();
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(2);

    recoverySnapshot.resolve({
      epoch: "epoch-b",
      revision: 3,
      previews: [webPreview("epoch-b-recovered")],
    });
    await flushMicrotasks();
    expect(usePreviewStore.getState().authoritative).toMatchObject({
      syncStatus: "synchronized",
      epoch: "epoch-b",
      revision: 3,
      previews: [expect.objectContaining({ previewId: "epoch-b-recovered" })],
    });
  });

  it("requests a post-event Device snapshot when a new epoch arrives during an old snapshot", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const oldSnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    const newSnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    fake.api.requestDevicePreviewList
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockReturnValueOnce(newSnapshot.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    const initialSync = controller.syncDeviceSnapshot(scope);
    expect(
      controller.applyDevicePreviewState(
        fake.relay,
        scope,
        devicePreview("epoch-b-event"),
        "epoch-b",
        1,
      ),
    ).toMatchObject({ status: "needs-resync", reason: "unknown-epoch" });

    oldSnapshot.resolve({
      epoch: "epoch-a",
      revision: 20,
      previews: [devicePreview("epoch-a")],
    });
    await initialSync;
    await flushMicrotasks();
    expect(fake.api.requestDevicePreviewList).toHaveBeenCalledTimes(2);

    newSnapshot.resolve({
      epoch: "epoch-b",
      revision: 1,
      previews: [devicePreview("epoch-b")],
    });
    await flushMicrotasks();
    expect(useDevicePreviewStore.getState().authoritative).toMatchObject({
      syncStatus: "synchronized",
      epoch: "epoch-b",
      revision: 1,
      previews: [expect.objectContaining({ previewId: "epoch-b" })],
    });
  });

  it("keeps the Device resync latch until a post-event snapshot succeeds", async () => {
    vi.useFakeTimers();
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const oldSnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    const failedRecovery = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    const successfulRecovery = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    fake.api.requestDevicePreviewList
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockReturnValueOnce(failedRecovery.promise)
      .mockReturnValueOnce(successfulRecovery.promise);
    const reportError = vi.fn();
    const controller = new PreviewController({ reportBackgroundError: reportError });

    try {
      controller.activate(fake.relay, scope);
      const initialSync = controller.syncDeviceSnapshot(scope);
      controller.applyDevicePreviewState(
        fake.relay,
        scope,
        devicePreview("epoch-b-event"),
        "epoch-b",
        1,
      );

      oldSnapshot.resolve({
        epoch: "epoch-a",
        revision: 20,
        previews: [devicePreview("stale-epoch-a")],
      });
      await initialSync;
      await flushMicrotasks();
      expect(fake.api.requestDevicePreviewList).toHaveBeenCalledTimes(2);
      expect(useDevicePreviewStore.getState().authoritative).toMatchObject({
        syncStatus: "needs-resync",
        previews: [],
      });

      failedRecovery.reject(new Error("snapshot unavailable"));
      await flushMicrotasks();
      expect(reportError).toHaveBeenCalledWith("device-resync", expect.any(Error));
      expect(useDevicePreviewStore.getState().authoritative?.syncStatus).toBe("needs-resync");

      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(fake.api.requestDevicePreviewList).toHaveBeenCalledTimes(3);

      successfulRecovery.resolve({
        epoch: "epoch-b",
        revision: 1,
        previews: [devicePreview("epoch-b")],
      });
      await flushMicrotasks();
      expect(useDevicePreviewStore.getState().authoritative).toMatchObject({
        syncStatus: "synchronized",
        epoch: "epoch-b",
        revision: 1,
        previews: [expect.objectContaining({ previewId: "epoch-b" })],
      });
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("requests a second Device snapshot when a late old-epoch event arrives during a current flight", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const currentSnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    const recoverySnapshot = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    fake.api.requestDevicePreviewList
      .mockReturnValueOnce(currentSnapshot.promise)
      .mockReturnValueOnce(recoverySnapshot.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    useDevicePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "epoch-b",
      revision: 1,
      previews: [devicePreview("epoch-b")],
    });

    const inFlightSync = controller.syncDeviceSnapshot(scope);
    expect(
      controller.applyDevicePreviewState(fake.relay, scope, devicePreview("late-a"), "epoch-a", 99),
    ).toMatchObject({ status: "needs-resync", reason: "unknown-epoch" });
    currentSnapshot.resolve({
      epoch: "epoch-b",
      revision: 2,
      previews: [devicePreview("epoch-b")],
    });
    await inFlightSync;
    await flushMicrotasks();
    expect(fake.api.requestDevicePreviewList).toHaveBeenCalledTimes(2);

    recoverySnapshot.resolve({
      epoch: "epoch-b",
      revision: 3,
      previews: [devicePreview("epoch-b-recovered")],
    });
    await flushMicrotasks();
    expect(useDevicePreviewStore.getState().authoritative).toMatchObject({
      syncStatus: "synchronized",
      epoch: "epoch-b",
      revision: 3,
      previews: [expect.objectContaining({ previewId: "epoch-b-recovered" })],
    });
  });

  it("does not let a late A snapshot overwrite a new binding of the same Proxy", async () => {
    const oldScope = createPreviewScope("proxy-a", "binding-old");
    const newScope = createPreviewScope("proxy-a", "binding-new");
    const oldRelay = createFakeRelay(oldScope);
    const newRelay = createFakeRelay(newScope);
    const oldRequest = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    oldRelay.api.requestWebPreviewList.mockReturnValue(oldRequest.promise);
    newRelay.api.requestWebPreviewList.mockResolvedValue({
      epoch: "epoch-new",
      revision: 0,
      previews: [webPreview("new")],
    });
    const controller = new PreviewController();
    controller.activate(oldRelay.relay, oldScope);
    const oldSync = controller.syncWebSnapshot(oldScope);

    controller.activate(newRelay.relay, newScope);
    await controller.syncWebSnapshot(newScope);
    oldRequest.resolve({
      epoch: "epoch-old",
      revision: 99,
      previews: [webPreview("old")],
    });
    await expect(oldSync).rejects.toMatchObject({ name: "AbortError" });
    expect(usePreviewStore.getState().authoritative).toMatchObject({
      scope: newScope,
      epoch: "epoch-new",
      previews: [expect.objectContaining({ previewId: "new" })],
    });
  });
});

describe("PreviewController operations", () => {
  it("settles rejected Web and Device creates without requesting snapshots", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    fake.api.createWebPreview.mockResolvedValue({
      operationId: "web-create-rejected",
      accepted: false,
      error: "web rejected",
      errorCode: "UNKNOWN",
    });
    fake.api.createDevicePreview.mockResolvedValue({
      operationId: "device-create-rejected",
      accepted: false,
      error: "device rejected",
      errorCode: "UNKNOWN",
    });
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    await expect(
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:5173" },
        { tunnelProvider: "cloudflare", operationId: "web-create-rejected" },
      ),
    ).resolves.toMatchObject({ accepted: false, error: "web rejected" });
    await expect(
      controller.createDevicePreview(scope, "target-1", {
        operationId: "device-create-rejected",
      }),
    ).resolves.toMatchObject({ accepted: false, error: "device rejected" });

    expect(fake.api.requestWebPreviewList).not.toHaveBeenCalled();
    expect(fake.api.requestDevicePreviewList).not.toHaveBeenCalled();
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
  });

  it("confirms push-first Web and Device creates without requesting snapshots", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const webAck = deferred<{
      operationId: string;
      accepted: true;
      previewId: string;
    }>();
    const deviceAck = deferred<{
      operationId: string;
      accepted: true;
      previewId: string;
    }>();
    fake.api.createWebPreview.mockReturnValue(webAck.promise);
    fake.api.createDevicePreview.mockReturnValue(deviceAck.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    usePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "web-epoch",
      revision: 0,
      previews: [],
    });
    useDevicePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "device-epoch",
      revision: 0,
      previews: [],
    });

    const webCreate = controller.createWebPreview(
      scope,
      { kind: "local", url: "http://localhost:5173" },
      { tunnelProvider: "cloudflare", operationId: "web-push-first" },
    );
    const deviceCreate = controller.createDevicePreview(scope, "target-1", {
      operationId: "device-push-first",
    });
    controller.applyWebPreviewState(
      fake.relay,
      scope,
      webPreview("web-push-created"),
      "web-epoch",
      1,
    );
    controller.applyDevicePreviewState(
      fake.relay,
      scope,
      devicePreview("device-push-created"),
      "device-epoch",
      1,
    );
    webAck.resolve({
      operationId: "web-push-first",
      accepted: true,
      previewId: "web-push-created",
    });
    deviceAck.resolve({
      operationId: "device-push-first",
      accepted: true,
      previewId: "device-push-created",
    });

    await expect(webCreate).resolves.toMatchObject({ previewId: "web-push-created" });
    await expect(deviceCreate).resolves.toMatchObject({ previewId: "device-push-created" });
    expect(fake.api.requestWebPreviewList).not.toHaveBeenCalled();
    expect(fake.api.requestDevicePreviewList).not.toHaveBeenCalled();
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
  });

  it("keeps a Web create pending through its post-ACK authoritative confirmation", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const snapshot = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    fake.api.requestWebPreviewList.mockReturnValue(snapshot.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    const create = controller.createWebPreview(
      scope,
      { kind: "local", url: "http://localhost:5173" },
      {
        tunnelProvider: "cloudflare",
        operationId: "web-confirm",
        timeoutMs: 4321,
      },
    );
    await flushMicrotasks();

    expect(fake.api.requestWebPreviewList).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ timeoutMs: 4321, signal: expect.any(AbortSignal) }),
    );
    expect(usePreviewOperationStore.getState().registry.operations).toMatchObject([
      { kind: "create", previewKind: "web", operationId: "web-confirm" },
    ]);

    snapshot.resolve({
      epoch: "web-epoch",
      revision: 1,
      previews: [webPreview("web-created")],
    });
    await expect(create).resolves.toMatchObject({ accepted: true, previewId: "web-created" });
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
  });

  it("rejects Web and Device create ACKs whose authoritative snapshots omit their ids", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    fake.api.requestWebPreviewList.mockResolvedValue({
      epoch: "web-epoch",
      revision: 1,
      previews: [],
    });
    fake.api.requestDevicePreviewList.mockResolvedValue({
      epoch: "device-epoch",
      revision: 1,
      previews: [],
    });
    const controller = new PreviewController({ reportBackgroundError: vi.fn() });
    controller.activate(fake.relay, scope);

    const results = await Promise.allSettled([
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:5173" },
        { tunnelProvider: "cloudflare", operationId: "web-missing" },
      ),
      controller.createDevicePreview(scope, "target-1", {
        operationId: "device-missing",
      }),
    ]);

    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        name: "PreviewCreateConfirmationError",
        previewKind: "web",
        previewId: "web-created",
      }),
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        name: "PreviewCreateConfirmationError",
        previewKind: "device",
        previewId: "device-created",
      }),
    });
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
  });

  it("reports snapshot failures as create state-confirmation failures for both kinds", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const webSnapshotError = new Error("web snapshot failed");
    const deviceSnapshotError = new Error("device snapshot failed");
    fake.api.requestWebPreviewList.mockRejectedValue(webSnapshotError);
    fake.api.requestDevicePreviewList.mockRejectedValue(deviceSnapshotError);
    const controller = new PreviewController({ reportBackgroundError: vi.fn() });
    controller.activate(fake.relay, scope);

    const results = await Promise.allSettled([
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:5173" },
        { tunnelProvider: "cloudflare", operationId: "web-snapshot-failure" },
      ),
      controller.createDevicePreview(scope, "target-1", {
        operationId: "device-snapshot-failure",
      }),
    ]);

    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("暂时无法确认状态"),
        confirmationCause: webSnapshotError,
      }),
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("暂时无法确认状态"),
        confirmationCause: deviceSnapshotError,
      }),
    });
  });

  it("rejects a create when a needs-resync snapshot still omits the acknowledged id", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    fake.api.requestWebPreviewList
      .mockResolvedValueOnce({ epoch: "web-epoch", revision: 2, previews: [] })
      .mockResolvedValue({ epoch: "web-epoch", revision: 3, previews: [] });
    const controller = new PreviewController({ reportBackgroundError: vi.fn() });
    controller.activate(fake.relay, scope);
    usePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "web-epoch",
      revision: 1,
      previews: [],
    });
    usePreviewStore.getState().applyPreviewState(scope, webPreview("unrelated"), "web-epoch", 3);

    await expect(
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:5173" },
        { tunnelProvider: "cloudflare", operationId: "web-needs-resync" },
      ),
    ).rejects.toBeInstanceOf(PreviewCreateConfirmationError);
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
  });

  it("rejects Device confirmation when its active binding changes", async () => {
    const scopeA = createPreviewScope("proxy-a", "binding-a");
    const scopeB = createPreviewScope("proxy-b", "binding-b");
    const relayA = createFakeRelay(scopeA);
    const relayB = createFakeRelay(scopeB);
    relayA.api.requestDevicePreviewList.mockImplementation((_scope, options) =>
      rejectWhenAborted(options?.signal),
    );
    const controller = new PreviewController();
    controller.activate(relayA.relay, scopeA);

    const create = controller.createDevicePreview(scopeA, "target-1", {
      operationId: "device-switch",
    });
    await flushMicrotasks();
    expect(relayA.api.requestDevicePreviewList).toHaveBeenCalledTimes(1);
    controller.activate(relayB.relay, scopeB);

    await expect(create).rejects.toMatchObject({ name: "AbortError" });
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
    expect(useDevicePreviewStore.getState().authoritative?.scope).toEqual(scopeB);
  });

  it("does not confirm an A1 create from the same id in an A2 binding", async () => {
    const scopeA1 = createPreviewScope("proxy-a", "binding-a-1");
    const scopeB = createPreviewScope("proxy-b", "binding-b");
    const scopeA2 = createPreviewScope("proxy-a", "binding-a-2");
    const relayA1 = createFakeRelay(scopeA1);
    const relayB = createFakeRelay(scopeB);
    const relayA2 = createFakeRelay(scopeA2);
    relayA1.api.requestWebPreviewList.mockImplementation((_scope, options) =>
      rejectWhenAborted(options?.signal),
    );
    const controller = new PreviewController();
    controller.activate(relayA1.relay, scopeA1);

    const oldCreate = controller.createWebPreview(
      scopeA1,
      { kind: "local", url: "http://localhost:5173" },
      { tunnelProvider: "cloudflare", operationId: "web-a1" },
    );
    await flushMicrotasks();
    expect(relayA1.api.requestWebPreviewList).toHaveBeenCalledTimes(1);

    controller.activate(relayB.relay, scopeB);
    controller.activate(relayA2.relay, scopeA2);
    usePreviewStore.getState().replaceSnapshot(scopeA2, {
      epoch: "web-a2-epoch",
      revision: 1,
      previews: [webPreview("web-created")],
    });

    await expect(oldCreate).rejects.toMatchObject({ name: "AbortError" });
    expect(usePreviewStore.getState().authoritative).toMatchObject({
      scope: scopeA2,
      previews: [expect.objectContaining({ previewId: "web-created" })],
    });
  });

  it("rethrows a lost create ACK before background reconciliation and permits same-id retry", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const ackLost = new Error("create ACK lost");
    const reconciliation = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    fake.api.createWebPreview.mockRejectedValueOnce(ackLost);
    fake.api.requestWebPreviewList.mockReturnValueOnce(reconciliation.promise);
    const controller = new PreviewController({ reportBackgroundError: vi.fn() });
    controller.activate(fake.relay, scope);

    const first = controller.createWebPreview(
      scope,
      { kind: "local", url: "http://localhost:5173" },
      { tunnelProvider: "cloudflare", operationId: "stable-create-id" },
    );
    await expect(first).rejects.toBe(ackLost);
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(1);
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);

    reconciliation.resolve({
      epoch: "web-epoch",
      revision: 1,
      previews: [webPreview("web-created")],
    });
    await flushMicrotasks();
    await expect(
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:5173" },
        { tunnelProvider: "cloudflare", operationId: "stable-create-id" },
      ),
    ).resolves.toMatchObject({ accepted: true, previewId: "web-created" });
    expect(fake.api.createWebPreview.mock.calls.map((call) => call[2].operationId)).toEqual([
      "stable-create-id",
      "stable-create-id",
    ]);
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(1);
  });

  it("settles a non-create command on ACK while its snapshot reconciliation continues", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const closeRequest = deferred<{
      operationId: string;
      previewId: string;
      success: false;
      error: string;
      errorCode: "UNKNOWN";
    }>();
    const reconciliation = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    fake.api.closeWebPreview.mockReturnValue(closeRequest.promise);
    fake.api.requestWebPreviewList.mockReturnValue(reconciliation.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    usePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "epoch-a",
      revision: 1,
      previews: [webPreview("preview-1")],
    });

    const mutation = controller.closeWebPreview(scope, "preview-1", {
      operationId: "close-1",
    });
    expect(usePreviewOperationStore.getState().registry.operations).toMatchObject([
      { kind: "close", previewKind: "web", operationId: "close-1" },
    ]);
    controller.applyWebPreviewState(
      fake.relay,
      scope,
      webPreview("preview-1", "failed"),
      "epoch-a",
      2,
    );

    closeRequest.resolve({
      operationId: "close-1",
      previewId: "preview-1",
      success: false,
      error: "close failed",
      errorCode: "UNKNOWN",
    });
    await expect(mutation).resolves.toMatchObject({ success: false, operationId: "close-1" });
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
    expect(usePreviewStore.getState().authoritative?.previews[0]?.state).toBe("failed");
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(1);

    reconciliation.resolve({
      epoch: "epoch-a",
      revision: 2,
      previews: [webPreview("preview-1", "failed")],
    });
    await flushMicrotasks();
    expect(usePreviewStore.getState().authoritative?.previews[0]?.state).toBe("failed");
  });

  it("rejects a failed non-create command immediately and reconciles in the background", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const failure = new Error("ACK lost");
    const reconciliation = deferred<{
      epoch: string;
      revision: number;
      previews: PreviewSummary[];
    }>();
    fake.api.reconnectWebPreview.mockRejectedValue(failure);
    fake.api.requestWebPreviewList.mockReturnValue(reconciliation.promise);
    const controller = new PreviewController({ reportBackgroundError: vi.fn() });
    controller.activate(fake.relay, scope);

    await expect(
      controller.reconnectWebPreview(scope, "preview-1", { operationId: "reconnect-1" }),
    ).rejects.toBe(failure);
    expect(fake.api.requestWebPreviewList).toHaveBeenCalledTimes(1);
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
    expect(usePreviewStore.getState().authoritative?.previews).toEqual([]);

    reconciliation.resolve({
      epoch: "epoch-a",
      revision: 1,
      previews: [webPreview("preview-1")],
    });
    await flushMicrotasks();
    expect(usePreviewStore.getState().authoritative?.previews[0]?.previewId).toBe("preview-1");
  });

  it("blocks overlapping creates and every overlapping mutation on one preview", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const createRequest = deferred<{
      operationId: string;
      accepted: true;
      previewId: string;
    }>();
    const renameRequest = deferred<{
      operationId: string;
      previewId: string;
      success: true;
    }>();
    fake.api.createWebPreview.mockReturnValue(createRequest.promise);
    fake.api.requestWebPreviewList.mockResolvedValue({
      epoch: "web-epoch",
      revision: 1,
      previews: [webPreview("preview-1")],
    });
    fake.api.renameWebPreview.mockReturnValue(renameRequest.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    const firstCreate = controller.createWebPreview(
      scope,
      { kind: "local", url: "http://localhost:5173" },
      { tunnelProvider: "cloudflare", operationId: "create-1" },
    );
    await expect(
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:4173" },
        { tunnelProvider: "cloudflare", operationId: "create-2" },
      ),
    ).rejects.toBeInstanceOf(PreviewOperationConflictError);
    expect(fake.api.createWebPreview).toHaveBeenCalledTimes(1);

    createRequest.resolve({ operationId: "create-1", accepted: true, previewId: "preview-1" });
    await firstCreate;
    const rename = controller.renameWebPreview(scope, "preview-1", "new name", {
      operationId: "rename-1",
    });
    expect(
      controller.renameWebPreview(scope, "preview-1", "new name", {
        operationId: "rename-1",
      }),
    ).toBe(rename);
    await expect(
      controller.closeWebPreview(scope, "preview-1", { operationId: "close-1" }),
    ).rejects.toBeInstanceOf(PreviewOperationConflictError);
    await expect(
      controller.renameWebPreview(scope, "preview-2", "other", {
        operationId: "rename-1",
      }),
    ).rejects.toBeInstanceOf(PreviewOperationConflictError);
    expect(fake.api.closeWebPreview).not.toHaveBeenCalled();
    expect(fake.api.renameWebPreview).toHaveBeenCalledTimes(1);

    renameRequest.resolve({ operationId: "rename-1", previewId: "preview-1", success: true });
    await rename;
  });

  it("joins only an identical Web create when an operation id is already in flight", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const request = deferred<{
      operationId: string;
      accepted: false;
      error: string;
      errorCode: "UNKNOWN";
    }>();
    fake.api.createWebPreview.mockReturnValue(request.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    const first = controller.createWebPreview(
      scope,
      { kind: "local", url: "http://localhost:5173" },
      {
        tunnelProvider: "cloudflare",
        name: " Demo ",
        operationId: "shared-operation-id",
        timeoutMs: 100,
      },
    );
    const exactRetry = controller.createWebPreview(
      scope,
      { kind: "local", url: "http://localhost:5173" },
      {
        tunnelProvider: "cloudflare",
        name: "Demo",
        operationId: "shared-operation-id",
        timeoutMs: 5_000,
      },
    );

    expect(exactRetry).toBe(first);
    for (const retry of [
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:4173" },
        { tunnelProvider: "cloudflare", name: "Demo", operationId: "shared-operation-id" },
      ),
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:5173" },
        { tunnelProvider: "cpolar", name: "Demo", operationId: "shared-operation-id" },
      ),
      controller.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:5173" },
        { tunnelProvider: "cloudflare", name: "Other", operationId: "shared-operation-id" },
      ),
      controller.createDevicePreview(scope, "target-1", {
        operationId: "shared-operation-id",
      }),
    ]) {
      await expect(retry).rejects.toMatchObject({
        name: "PreviewOperationConflictError",
        reason: "operation-id-conflict",
      });
    }

    expect(fake.api.createWebPreview).toHaveBeenCalledTimes(1);
    expect(fake.api.createDevicePreview).not.toHaveBeenCalled();
    request.resolve({
      operationId: "shared-operation-id",
      accepted: false,
      error: "rejected",
      errorCode: "UNKNOWN",
    });
    await expect(first).resolves.toMatchObject({ accepted: false });
  });

  it("joins only identical Device create and rename parameters for one operation id", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const createRequest = deferred<{
      operationId: string;
      accepted: false;
      error: string;
      errorCode: "UNKNOWN";
    }>();
    const renameRequest = deferred<{
      operationId: string;
      previewId: string;
      success: true;
    }>();
    fake.api.createDevicePreview.mockReturnValue(createRequest.promise);
    fake.api.renameDevicePreview.mockReturnValue(renameRequest.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    const create = controller.createDevicePreview(scope, "target-1", {
      name: " Pixel ",
      operationId: "device-create-id",
    });
    expect(
      controller.createDevicePreview(scope, "target-1", {
        name: "Pixel",
        operationId: "device-create-id",
      }),
    ).toBe(create);
    await expect(
      controller.createDevicePreview(scope, "target-2", {
        name: "Pixel",
        operationId: "device-create-id",
      }),
    ).rejects.toMatchObject({ reason: "operation-id-conflict" });
    await expect(
      controller.createDevicePreview(scope, "target-1", {
        name: "Tablet",
        operationId: "device-create-id",
      }),
    ).rejects.toMatchObject({ reason: "operation-id-conflict" });
    expect(fake.api.createDevicePreview).toHaveBeenCalledTimes(1);
    createRequest.resolve({
      operationId: "device-create-id",
      accepted: false,
      error: "rejected",
      errorCode: "UNKNOWN",
    });
    await create;

    const rename = controller.renameDevicePreview(scope, "device-1", " New name ", {
      operationId: "device-rename-id",
    });
    expect(
      controller.renameDevicePreview(scope, "device-1", "New name", {
        operationId: "device-rename-id",
      }),
    ).toBe(rename);
    await expect(
      controller.renameDevicePreview(scope, "device-1", "Different name", {
        operationId: "device-rename-id",
      }),
    ).rejects.toMatchObject({ reason: "operation-id-conflict" });
    await expect(
      controller.renameWebPreview(scope, "preview-1", "New name", {
        operationId: "device-rename-id",
      }),
    ).rejects.toMatchObject({ reason: "operation-id-conflict" });
    expect(fake.api.renameDevicePreview).toHaveBeenCalledTimes(1);
    expect(fake.api.renameWebPreview).not.toHaveBeenCalled();
    renameRequest.resolve({
      operationId: "device-rename-id",
      previewId: "device-1",
      success: true,
    });
    await rename;
  });

  it("waits for a post-ACK Device snapshot so create callers can navigate to its row", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const ack = deferred<{
      operationId: string;
      accepted: true;
      previewId: string;
    }>();
    const snapshot = deferred<{
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }>();
    fake.api.createDevicePreview.mockReturnValue(ack.promise);
    fake.api.requestDevicePreviewList.mockReturnValue(snapshot.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    const create = controller.createDevicePreview(scope, "target-1", {
      operationId: "device-create-1",
      timeoutMs: 5432,
    });
    ack.resolve({
      operationId: "device-create-1",
      accepted: true,
      previewId: "device-created",
    });
    await flushMicrotasks();
    expect(fake.api.requestDevicePreviewList).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ timeoutMs: 5432, signal: expect.any(AbortSignal) }),
    );
    expect(useDevicePreviewStore.getState().authoritative?.previews).toEqual([]);
    expect(usePreviewOperationStore.getState().registry.operations).toMatchObject([
      { kind: "create", previewKind: "device", operationId: "device-create-1" },
    ]);

    snapshot.resolve({
      epoch: "device-epoch",
      revision: 1,
      previews: [devicePreview("device-created")],
    });
    await expect(create).resolves.toMatchObject({ previewId: "device-created" });
    expect(useDevicePreviewStore.getState().authoritative?.previews[0]?.previewId).toBe(
      "device-created",
    );
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
  });

  it("routes every Device mutation through operation ids and snapshot reconciliation", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    await controller.renameDevicePreview(scope, "device-1", "renamed", {
      operationId: "device-rename-1",
    });
    await controller.reconnectDevicePreview(scope, "device-1", {
      operationId: "device-reconnect-1",
    });
    await controller.closeDevicePreview(scope, "device-1", {
      operationId: "device-close-1",
    });

    expect(fake.api.renameDevicePreview.mock.calls[0]?.[3]?.operationId).toBe("device-rename-1");
    expect(fake.api.reconnectDevicePreview.mock.calls[0]?.[2]?.operationId).toBe(
      "device-reconnect-1",
    );
    expect(fake.api.closeDevicePreview.mock.calls[0]?.[2]?.operationId).toBe("device-close-1");
    expect(fake.api.requestDevicePreviewList).toHaveBeenCalledTimes(3);
    expect(usePreviewOperationStore.getState().registry.operations).toEqual([]);
  });
});

describe("PreviewController scoped capability, target, and inspection wrappers", () => {
  it("commits scoped capability results and forwards the shared abort signal", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const webCapability: WebPreviewCapability = {
      cloudflared: { available: true, command: "cloudflared" },
      cpolar: { available: false, error: "Cpolar not found" },
    };
    const deviceCapability: DevicePreviewCapability = {
      ios: { supported: true, available: true, interactive: true, command: "baguette" },
      android: { supported: true, available: true, interactive: true, command: "adb" },
    };
    fake.api.requestWebPreviewCapability.mockResolvedValue({
      success: true,
      capability: webCapability,
    });
    fake.api.requestDevicePreviewCapability.mockResolvedValue({
      success: true,
      capability: deviceCapability,
    });
    fake.api.requestDevicePreviewTargets.mockResolvedValue({
      success: true,
      targets: [
        {
          targetId: "target-1",
          platform: "ios",
          name: "iPhone 17 Pro",
          model: "iPhone 17 Pro",
          osVersion: "26.4",
          interactive: true,
        },
      ],
    });
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);

    await controller.requestWebPreviewCapability(scope, true);
    await controller.requestDevicePreviewCapability(scope, true);
    await controller.requestDevicePreviewTargets(scope, true);
    await controller.inspectStaticWebPreview(scope, "/site");

    expect(usePreviewStore.getState().capability).toEqual(webCapability);
    expect(useDevicePreviewStore.getState().capability).toEqual(deviceCapability);
    expect(useDevicePreviewStore.getState().targets[0]?.targetId).toBe("target-1");
    expect(fake.api.requestWebPreviewCapability.mock.calls[0]?.[2]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fake.api.requestDevicePreviewCapability.mock.calls[0]?.[2]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fake.api.requestDevicePreviewTargets.mock.calls[0]?.[2]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fake.api.inspectStaticWebPreview.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("owns device capability loading and both response and transport errors", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    fake.api.requestDevicePreviewCapability.mockResolvedValueOnce({
      success: false,
      error: "capability response failed",
      errorCode: "UNKNOWN",
    });

    const failedResponse = controller.requestDevicePreviewCapability(scope, true);
    expect(useDevicePreviewStore.getState()).toMatchObject({
      capabilityStatus: "loading",
      capabilityError: null,
    });
    await expect(failedResponse).resolves.toEqual({
      success: false,
      error: "capability response failed",
      errorCode: "UNKNOWN",
    });
    expect(useDevicePreviewStore.getState()).toMatchObject({
      capabilityStatus: "error",
      capabilityError: "capability response failed",
    });

    fake.api.requestDevicePreviewCapability.mockRejectedValueOnce(
      new Error("capability transport failed"),
    );
    await expect(controller.requestDevicePreviewCapability(scope, false)).rejects.toThrow(
      "capability transport failed",
    );
    expect(useDevicePreviewStore.getState()).toMatchObject({
      capabilityStatus: "error",
      capabilityError: "capability transport failed",
    });
  });

  it("owns Web capability loading and both response and transport errors", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    fake.api.requestWebPreviewCapability.mockResolvedValueOnce({
      success: false,
      error: "capability response failed",
      errorCode: "UNKNOWN",
    });

    const failedResponse = controller.requestWebPreviewCapability(scope, true);
    expect(usePreviewStore.getState()).toMatchObject({
      capabilityStatus: "loading",
      capabilityError: null,
    });
    await expect(failedResponse).resolves.toEqual({
      success: false,
      error: "capability response failed",
      errorCode: "UNKNOWN",
    });
    expect(usePreviewStore.getState()).toMatchObject({
      capabilityStatus: "error",
      capabilityError: "capability response failed",
    });

    fake.api.requestWebPreviewCapability.mockRejectedValueOnce(
      new Error("capability transport failed"),
    );
    await expect(controller.requestWebPreviewCapability(scope, false)).rejects.toThrow(
      "capability transport failed",
    );
    expect(usePreviewStore.getState()).toMatchObject({
      capabilityStatus: "error",
      capabilityError: "capability transport failed",
    });
  });

  it("does not commit a Web capability result after the active scope changes", async () => {
    const oldScope = createPreviewScope("proxy-a", "binding-a-1");
    const newScope = createPreviewScope("proxy-a", "binding-a-2");
    const fake = createFakeRelay(oldScope);
    const capabilityRequest = deferred<{
      success: true;
      capability: WebPreviewCapability;
    }>();
    fake.api.requestWebPreviewCapability.mockReturnValueOnce(capabilityRequest.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, oldScope);

    const pending = controller.requestWebPreviewCapability(oldScope);
    expect(usePreviewStore.getState().capabilityStatus).toBe("loading");
    fake.setScope(newScope);
    controller.activate(fake.relay, newScope);
    capabilityRequest.resolve({
      success: true,
      capability: {
        cloudflared: { available: true, command: "cloudflared" },
        cpolar: { available: false, error: "Cpolar not found" },
      },
    });

    await expect(pending).rejects.toBeDefined();
    expect(usePreviewStore.getState()).toMatchObject({
      authoritative: { scope: newScope },
      capability: null,
      capabilityStatus: "idle",
      capabilityError: null,
    });
  });

  it("does not commit a device capability result after the active scope changes", async () => {
    const oldScope = createPreviewScope("proxy-a", "binding-a-1");
    const newScope = createPreviewScope("proxy-a", "binding-a-2");
    const fake = createFakeRelay(oldScope);
    const capabilityRequest = deferred<{
      success: true;
      capability: DevicePreviewCapability;
    }>();
    fake.api.requestDevicePreviewCapability.mockReturnValueOnce(capabilityRequest.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, oldScope);

    const pending = controller.requestDevicePreviewCapability(oldScope);
    expect(useDevicePreviewStore.getState().capabilityStatus).toBe("loading");
    fake.setScope(newScope);
    controller.activate(fake.relay, newScope);
    capabilityRequest.resolve({
      success: true,
      capability: {
        ios: { supported: true, available: true, interactive: true, command: "baguette" },
        android: { supported: true, available: true, interactive: true, command: "adb" },
      },
    });

    await expect(pending).rejects.toBeDefined();
    expect(useDevicePreviewStore.getState()).toMatchObject({
      authoritative: { scope: newScope },
      capability: null,
      capabilityStatus: "idle",
      capabilityError: null,
    });
  });

  it("binds stream access, input, and control claims to the active scope", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    const callerAbort = new AbortController();

    const access = await controller.requestDevicePreviewStream(
      scope,
      "device-1",
      { format: "jpeg", maxFps: 15 },
      { signal: callerAbort.signal },
    );
    expect(access).toMatchObject({
      scope,
      previewId: "device-1",
      leaseId: "lease-1",
      success: true,
    });
    if (!access?.success || !access.url || !access.leaseId) {
      throw new Error("expected active stream access");
    }
    const activeAccess = {
      ...access,
      success: true as const,
      url: access.url,
      leaseId: access.leaseId,
    };

    await controller.sendDevicePreviewInput(activeAccess, { kind: "button", button: "home" });
    await controller.claimDevicePreviewControl(activeAccess);

    expect(fake.api.requestDevicePreviewStream.mock.calls[0]?.[0]).toEqual(scope);
    expect(fake.api.requestDevicePreviewStream.mock.calls[0]?.[3]?.signal).toBe(access.signal);
    expect(fake.api.sendDevicePreviewInput.mock.calls[0]?.[0]).toEqual(scope);
    expect(fake.api.sendDevicePreviewInput.mock.calls[0]?.[1]).toBe("lease-1");
    expect(fake.api.claimDevicePreviewControl.mock.calls[0]?.[0]).toEqual(scope);
    expect(fake.api.claimDevicePreviewControl.mock.calls[0]?.[1]).toBe("lease-1");
  });

  it("aborts stream control work across a same-Proxy binding replacement", async () => {
    const scopeA = createPreviewScope("proxy-a", "binding-a-1");
    const scopeB = createPreviewScope("proxy-a", "binding-a-2");
    const fake = createFakeRelay(scopeA);
    const controller = new PreviewController();
    controller.activate(fake.relay, scopeA);
    const accessResult = await controller.requestDevicePreviewStream(scopeA, "device-1", {
      format: "jpeg",
    });
    if (!accessResult?.success || !accessResult.url || !accessResult.leaseId) {
      throw new Error("expected active stream access");
    }
    const access = {
      ...accessResult,
      success: true as const,
      url: accessResult.url,
      leaseId: accessResult.leaseId,
    };
    const inputResult = deferred<{
      leaseId: string;
      inputSeq: number;
      success: true;
    }>();
    const claimResult = deferred<{ success: true; controlMode: "controller" }>();
    fake.api.sendDevicePreviewInput.mockReturnValue(inputResult.promise);
    fake.api.claimDevicePreviewControl.mockReturnValue(claimResult.promise);

    const input = controller.sendDevicePreviewInput(access, { kind: "button", button: "back" });
    const claim = controller.claimDevicePreviewControl(access);
    const inputSignal = fake.api.sendDevicePreviewInput.mock.calls[0]?.[3]?.signal;
    const claimSignal = fake.api.claimDevicePreviewControl.mock.calls[0]?.[2]?.signal;

    fake.setScope(scopeB);
    controller.activate(fake.relay, scopeB);
    expect(access.signal.aborted).toBe(true);
    expect(inputSignal?.aborted).toBe(true);
    expect(claimSignal?.aborted).toBe(true);

    inputResult.resolve({ leaseId: "lease-1", inputSeq: 2, success: true });
    claimResult.resolve({ success: true, controlMode: "controller" });
    await expect(input).rejects.toMatchObject({ name: "AbortError" });
    await expect(claim).rejects.toMatchObject({ name: "AbortError" });
  });

  it("combines caller cancellation without aborting the active binding", async () => {
    const scope = createPreviewScope("proxy-a", "binding-a");
    const fake = createFakeRelay(scope);
    const inspection = deferred<{
      success: true;
      entryPath: string;
      htmlEntries: string[];
    }>();
    fake.api.inspectStaticWebPreview.mockReturnValue(inspection.promise);
    const controller = new PreviewController();
    controller.activate(fake.relay, scope);
    const callerAbort = new AbortController();

    const request = controller.inspectStaticWebPreview(scope, "/site", {
      signal: callerAbort.signal,
    });
    const combinedSignal = fake.api.inspectStaticWebPreview.mock.calls[0]?.[2]?.signal;
    expect(combinedSignal).not.toBe(callerAbort.signal);
    callerAbort.abort();
    expect(combinedSignal?.aborted).toBe(true);
    expect(controller.isActive(fake.relay, scope)).toBe(true);

    inspection.resolve({
      success: true,
      entryPath: "index.html",
      htmlEntries: ["index.html"],
    });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.getActiveScope()).toEqual(scope);
  });
});
