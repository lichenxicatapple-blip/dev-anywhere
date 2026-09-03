import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DevicePreviewCapability,
  DevicePreviewSummary,
  DevicePreviewTarget,
  PreviewScope,
} from "@dev-anywhere/shared";

const {
  scopeState,
  relayClient,
  requestDevicePreviewCapability,
  requestDevicePreviewTargets,
  createDevicePreview,
  getActiveScope,
  isActive,
  navigate,
  toastError,
} = vi.hoisted(() => ({
  scopeState: {
    current: Object.freeze({ proxyId: "proxy-a", bindingId: "binding-a-1" }) as PreviewScope,
  },
  relayClient: {},
  requestDevicePreviewCapability: vi.fn(),
  requestDevicePreviewTargets: vi.fn(),
  createDevicePreview: vi.fn(),
  getActiveScope: vi.fn(),
  isActive: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: relayClient,
  wsManagerRef: null,
}));

vi.mock("@/services/preview-controller", () => ({
  previewController: {
    getActiveScope,
    isActive,
    requestDevicePreviewCapability,
    requestDevicePreviewTargets,
    createDevicePreview,
  },
}));

vi.mock("@/components/toast", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

import { useAppStore } from "@/stores/app-store";
import { selectDevicePreviews, useDevicePreviewStore } from "@/stores/device-preview-store";
import { CreateDevicePreviewDialog } from "./create-device-preview-dialog";

const capability: DevicePreviewCapability = {
  ios: { supported: true, available: true, interactive: true, command: "baguette" },
  android: { supported: true, available: true, interactive: true, command: "adb" },
};

const target: DevicePreviewTarget = {
  targetId: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  name: "iPhone",
  model: "iPhone 17 Pro",
  osVersion: "26.4",
  interactive: true,
};

function devicePreview(
  previewId: string,
  name = target.name,
): Extract<DevicePreviewSummary, { state: "ready" }> {
  return {
    previewId,
    name,
    platform: target.platform,
    targetId: target.targetId,
    model: target.model,
    osVersion: target.osVersion,
    state: "ready",
    interactive: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function slot<T extends Element = HTMLElement>(root: HTMLElement, name: string): T {
  const element = root.querySelector<T>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`Missing data-slot: ${name}`);
  return element;
}

function sameScope(left: typeof scopeState.current, right: typeof scopeState.current): boolean {
  return left.proxyId === right.proxyId && left.bindingId === right.bindingId;
}

function activateScope(proxyId: string, bindingId: string): typeof scopeState.current {
  const scope = Object.freeze({ proxyId, bindingId });
  scopeState.current = scope;
  useAppStore.getState().setProxy(proxyId, `Machine ${proxyId}`);
  useDevicePreviewStore.getState().activateScope(scope);
  useDevicePreviewStore.getState().replaceSnapshot(scope, {
    epoch: `${bindingId}-epoch`,
    revision: 0,
    previews: [],
  });
  return scope;
}

describe("CreateDevicePreviewDialog", () => {
  beforeEach(() => {
    const scope = activateScope("proxy-a", "binding-a-1");
    getActiveScope.mockReset();
    getActiveScope.mockImplementation(() => scopeState.current);
    isActive.mockReset();
    isActive.mockImplementation(
      (candidateRelay, candidateScope) =>
        candidateRelay === relayClient && sameScope(candidateScope, scopeState.current),
    );
    requestDevicePreviewCapability.mockReset();
    requestDevicePreviewCapability.mockImplementation(async (candidateScope) => {
      if (sameScope(candidateScope, scopeState.current)) {
        useDevicePreviewStore.getState().setCapability(candidateScope, capability);
      }
      return { success: true, capability };
    });
    requestDevicePreviewTargets.mockReset();
    requestDevicePreviewTargets.mockImplementation(async (candidateScope) => {
      if (sameScope(candidateScope, scopeState.current)) {
        useDevicePreviewStore.getState().setTargets(candidateScope, [target]);
      }
      return { success: true, targets: [target] };
    });
    createDevicePreview.mockReset();
    navigate.mockReset();
    toastError.mockReset();
    expect(useDevicePreviewStore.getState().authoritative?.scope).toEqual(scope);
  });

  afterEach(() => cleanup());

  it("discovers targets only after capability configuration finishes", async () => {
    const capabilityRequest = deferred<{
      success: true;
      capability: DevicePreviewCapability;
    }>();
    requestDevicePreviewCapability.mockReturnValueOnce(capabilityRequest.promise);

    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    expect(requestDevicePreviewTargets).not.toHaveBeenCalled();
    capabilityRequest.resolve({ success: true, capability });

    await waitFor(() => expect(requestDevicePreviewTargets).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(slot(baseElement, "device-preview-target")).toHaveAttribute(
        "data-target-id",
        target.targetId,
      ),
    );
    expect(requestDevicePreviewCapability.mock.invocationCallOrder[0]).toBeLessThan(
      requestDevicePreviewTargets.mock.invocationCallOrder[0]!,
    );
    expect(requestDevicePreviewCapability).toHaveBeenCalledWith(scopeState.current, false, {
      signal: expect.any(AbortSignal),
    });
    expect(requestDevicePreviewTargets).toHaveBeenCalledWith(scopeState.current, true, {
      signal: expect.any(AbortSignal),
    });
    expect(slot(baseElement, "device-preview-target-device")).toHaveAttribute(
      "data-device-model",
      "iPhone 17 Pro",
    );
    expect(slot(baseElement, "device-preview-target-device")).toHaveAttribute(
      "data-os-version",
      "26.4",
    );
  });

  it("stops before target discovery when capability detection fails", async () => {
    requestDevicePreviewCapability.mockResolvedValueOnce({
      success: false,
      error: "capability detection failed",
    });

    render(<CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />);

    await waitFor(() => expect(requestDevicePreviewCapability).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestDevicePreviewTargets).not.toHaveBeenCalled());
  });

  it("does not auto-select or submit a target that already has a preview", async () => {
    useDevicePreviewStore
      .getState()
      .applyPreviewState(
        scopeState.current,
        { ...devicePreview("existing"), state: "ready", updatedAt: 2 },
        "binding-a-1-epoch",
        1,
      );
    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    await waitFor(() =>
      expect(slot(baseElement, "device-preview-target")).toHaveAttribute(
        "data-already-open",
        "true",
      ),
    );
    expect(slot<HTMLButtonElement>(baseElement, "device-preview-target")).toBeDisabled();
    expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeDisabled();
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    expect(createDevicePreview).not.toHaveBeenCalled();
  });

  it("passes a trimmed optional name and waits for the authoritative entity", async () => {
    createDevicePreview.mockResolvedValue({
      operationId: "operation-device-name",
      accepted: true,
      previewId: "device-preview-named",
    });
    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    await waitFor(() =>
      expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeEnabled(),
    );
    fireEvent.change(slot<HTMLInputElement>(baseElement, "device-preview-name"), {
      target: { value: "  Checkout iPhone  " },
    });
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));

    await waitFor(() =>
      expect(createDevicePreview).toHaveBeenCalledWith(scopeState.current, target.targetId, {
        operationId: expect.stringMatching(/^device-preview-operation-/),
        name: "Checkout iPhone",
      }),
    );
    expect(selectDevicePreviews(useDevicePreviewStore.getState())).toEqual([]);

    act(() => {
      useDevicePreviewStore
        .getState()
        .applyPreviewState(
          scopeState.current,
          devicePreview("device-preview-named", "Checkout iPhone"),
          "binding-a-1-epoch",
          1,
        );
    });
    expect(selectDevicePreviews(useDevicePreviewStore.getState())).toEqual([
      expect.objectContaining({
        previewId: "device-preview-named",
        name: "Checkout iPhone",
      }),
    ]);
  });

  it("distinguishes an outdated iOS helper from a missing executable", async () => {
    const outdatedCapability: DevicePreviewCapability = {
      ...capability,
      ios: {
        supported: true,
        available: false,
        interactive: false,
        command: "/opt/homebrew/bin/baguette",
        version: "0.1.95",
        error: "Baguette 版本过低，请升级到 0.1.96 或更高版本",
      },
    };
    requestDevicePreviewCapability.mockImplementationOnce(async (candidateScope) => {
      useDevicePreviewStore.getState().setCapability(candidateScope, outdatedCapability);
      return {
        success: true,
        capability: outdatedCapability,
      };
    });
    requestDevicePreviewTargets.mockResolvedValueOnce({ success: true, targets: [] });

    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    await waitFor(() =>
      expect(slot(baseElement, "device-preview-tool-status")).toHaveAttribute(
        "data-status",
        "outdated",
      ),
    );
    expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeDisabled();
  });

  it("does not render a duplicate tool description when the error equals the status title", async () => {
    const missingCapability: DevicePreviewCapability = {
      ...capability,
      ios: {
        supported: true,
        available: false,
        interactive: false,
        error: "未找到 Baguette",
      },
    };
    requestDevicePreviewCapability.mockImplementationOnce(async (candidateScope) => {
      useDevicePreviewStore.getState().setCapability(candidateScope, missingCapability);
      return {
        success: true,
        capability: missingCapability,
      };
    });
    requestDevicePreviewTargets.mockResolvedValueOnce({ success: true, targets: [] });

    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    await waitFor(() => slot(baseElement, "device-preview-tool-status"));
    expect(baseElement.querySelector('[data-slot="device-preview-tool-description"]')).toBeNull();
  });

  it("aborts and ignores a capability result that arrives after the dialog closes", async () => {
    const capabilityRequest = deferred<{
      success: true;
      capability: DevicePreviewCapability;
    }>();
    requestDevicePreviewCapability.mockReturnValueOnce(capabilityRequest.promise);
    const rendered = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );

    await waitFor(() => expect(requestDevicePreviewCapability).toHaveBeenCalledTimes(1));
    const signal = requestDevicePreviewCapability.mock.calls[0]?.[2]?.signal as
      | AbortSignal
      | undefined;
    rendered.rerender(
      <CreateDevicePreviewDialog open={false} platform="ios" onOpenChange={vi.fn()} />,
    );
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      capabilityRequest.resolve({ success: true, capability });
      await capabilityRequest.promise;
    });

    expect(requestDevicePreviewTargets).not.toHaveBeenCalled();
    expect(useDevicePreviewStore.getState().capability).toBeNull();
    expect(useDevicePreviewStore.getState().targets).toEqual([]);
  });

  it("keeps the current scope when old target discovery resolves after a switch", async () => {
    const oldTargetsRequest = deferred<{
      success: boolean;
      targets: DevicePreviewTarget[];
    }>();
    requestDevicePreviewTargets.mockReturnValueOnce(oldTargetsRequest.promise);
    const rendered = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );
    await waitFor(() => expect(requestDevicePreviewTargets).toHaveBeenCalledTimes(1));
    const oldScope = requestDevicePreviewTargets.mock.calls[0]?.[0];
    const signal = requestDevicePreviewTargets.mock.calls[0]?.[2]?.signal as
      | AbortSignal
      | undefined;
    const currentTarget = { ...target, targetId: "current-target", name: "Current iPhone" };

    act(() => {
      const currentScope = activateScope("proxy-b", "binding-b-1");
      useDevicePreviewStore.getState().setTargets(currentScope, [currentTarget]);
      rendered.rerender(
        <CreateDevicePreviewDialog open={false} platform="ios" onOpenChange={vi.fn()} />,
      );
    });
    expect(oldScope).toEqual({ proxyId: "proxy-a", bindingId: "binding-a-1" });
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      oldTargetsRequest.resolve({ success: true, targets: [target] });
      await oldTargetsRequest.promise;
    });

    expect(useDevicePreviewStore.getState()).toMatchObject({
      authoritative: { scope: { proxyId: "proxy-b", bindingId: "binding-b-1" } },
      targets: [expect.objectContaining({ targetId: "current-target" })],
    });
  });

  it("ignores an accepted create response after the dialog is externally closed", async () => {
    const createRequest = deferred<{
      operationId: string;
      accepted: boolean;
      previewId: string;
    }>();
    createDevicePreview.mockReturnValueOnce(createRequest.promise);
    const onOpenChange = vi.fn();
    const rendered = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={onOpenChange} />,
    );

    await waitFor(() =>
      expect(
        slot<HTMLButtonElement>(rendered.baseElement, "create-device-preview-submit"),
      ).not.toBeDisabled(),
    );
    fireEvent.click(slot(rendered.baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(1));
    expect(createDevicePreview).toHaveBeenCalledWith(scopeState.current, target.targetId, {
      operationId: expect.stringMatching(/^device-preview-operation-/),
    });

    rendered.rerender(
      <CreateDevicePreviewDialog open={false} platform="ios" onOpenChange={onOpenChange} />,
    );
    await act(async () => {
      createRequest.resolve({ operationId: "operation-one", accepted: true, previewId: "late" });
      await createRequest.promise;
    });

    expect(selectDevicePreviews(useDevicePreviewStore.getState())).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("retains an uncertain operation id and clears it after every definitive result", async () => {
    createDevicePreview
      .mockRejectedValueOnce(new Error("uncertain-device-create"))
      .mockResolvedValueOnce({
        operationId: "device-operation-retried",
        accepted: true,
        previewId: "device-preview-retried",
      })
      .mockResolvedValueOnce({
        operationId: "device-operation-rejected-one",
        accepted: false,
        error: "rejected-one",
      })
      .mockResolvedValueOnce({
        operationId: "device-operation-rejected-two",
        accepted: false,
        error: "rejected-two",
      });
    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );
    await waitFor(() =>
      expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeEnabled(),
    );

    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("uncertain-device-create"));
    await waitFor(() =>
      expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeEnabled(),
    );
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(2));
    expect(createDevicePreview.mock.calls[1]?.[2]?.operationId).toBe(
      createDevicePreview.mock.calls[0]?.[2]?.operationId,
    );

    await waitFor(() =>
      expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeEnabled(),
    );
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(3));
    expect(createDevicePreview.mock.calls[2]?.[2]?.operationId).not.toBe(
      createDevicePreview.mock.calls[1]?.[2]?.operationId,
    );

    await waitFor(() =>
      expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeEnabled(),
    );
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(4));
    expect(createDevicePreview.mock.calls[3]?.[2]?.operationId).not.toBe(
      createDevicePreview.mock.calls[2]?.[2]?.operationId,
    );
  });

  it("starts a new operation after the device name fingerprint changes", async () => {
    createDevicePreview.mockRejectedValueOnce(new Error("uncertain")).mockResolvedValueOnce({
      operationId: "device-operation-rejected",
      accepted: false,
      error: "rejected",
    });
    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );
    await waitFor(() =>
      expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeEnabled(),
    );
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("uncertain"));

    fireEvent.change(slot<HTMLInputElement>(baseElement, "device-preview-name"), {
      target: { value: "Changed name" },
    });
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(2));
    expect(createDevicePreview.mock.calls[1]?.[2]?.operationId).not.toBe(
      createDevicePreview.mock.calls[0]?.[2]?.operationId,
    );
  });

  it("starts a new operation after the device target fingerprint changes", async () => {
    const otherTarget: DevicePreviewTarget = {
      ...target,
      targetId: "00000000-0000-0000-0000-000000000002",
      name: "Other iPhone",
      model: "iPhone 16 Pro",
    };
    requestDevicePreviewTargets.mockImplementationOnce(async (candidateScope) => {
      useDevicePreviewStore.getState().setTargets(candidateScope, [target, otherTarget]);
      return { success: true, targets: [target, otherTarget] };
    });
    createDevicePreview.mockRejectedValueOnce(new Error("uncertain")).mockResolvedValueOnce({
      operationId: "device-operation-rejected",
      accepted: false,
      error: "rejected",
    });
    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );
    const firstTarget = await waitFor(() => {
      const element = baseElement.querySelector<HTMLElement>(
        `[data-slot="device-preview-target"][data-target-id="${target.targetId}"]`,
      );
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.click(firstTarget);
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("uncertain"));

    fireEvent.click(
      baseElement.querySelector(
        `[data-slot="device-preview-target"][data-target-id="${otherTarget.targetId}"]`,
      )!,
    );
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(2));
    expect(createDevicePreview.mock.calls[1]?.[1]).toBe(otherTarget.targetId);
    expect(createDevicePreview.mock.calls[1]?.[2]?.operationId).not.toBe(
      createDevicePreview.mock.calls[0]?.[2]?.operationId,
    );
  });

  it("reuses an uncertain operation id after reconnecting the same developer machine", async () => {
    const createRequest = deferred<never>();
    createDevicePreview.mockReturnValueOnce(createRequest.promise).mockResolvedValueOnce({
      operationId: "device-operation-retried",
      accepted: false,
      error: "already handled",
    });
    const { baseElement } = render(
      <CreateDevicePreviewDialog open platform="ios" onOpenChange={vi.fn()} />,
    );
    await waitFor(() =>
      expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeEnabled(),
    );
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(1));
    const operationId = createDevicePreview.mock.calls[0]?.[2]?.operationId;

    act(() => {
      activateScope("proxy-a", "binding-a-2");
    });
    await act(async () => {
      createRequest.reject(new Error("connection interrupted"));
      await createRequest.promise.catch(() => undefined);
    });
    await waitFor(() =>
      expect(slot<HTMLButtonElement>(baseElement, "create-device-preview-submit")).toBeEnabled(),
    );
    fireEvent.click(slot(baseElement, "create-device-preview-submit"));
    await waitFor(() => expect(createDevicePreview).toHaveBeenCalledTimes(2));

    expect(createDevicePreview.mock.calls[1]?.[0]).toEqual({
      proxyId: "proxy-a",
      bindingId: "binding-a-2",
    });
    expect(createDevicePreview.mock.calls[1]?.[2]?.operationId).toBe(operationId);
  });
});
