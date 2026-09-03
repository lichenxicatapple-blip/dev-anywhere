import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevicePreviewSummary, PreviewSummary } from "@dev-anywhere/shared";

const {
  activeScope,
  scopeState,
  reconnectWebPreview,
  closeWebPreview,
  renameWebPreview,
  reconnectDevicePreview,
  closeDevicePreview,
  renameDevicePreview,
  toastError,
} = vi.hoisted(() => ({
  activeScope: Object.freeze({ proxyId: "proxy-a", bindingId: "binding-a-1" }),
  scopeState: {
    current: Object.freeze({ proxyId: "proxy-a", bindingId: "binding-a-1" }) as {
      readonly proxyId: string;
      readonly bindingId: string;
    } | null,
  },
  reconnectWebPreview: vi.fn(),
  closeWebPreview: vi.fn(),
  renameWebPreview: vi.fn(),
  reconnectDevicePreview: vi.fn(),
  closeDevicePreview: vi.fn(),
  renameDevicePreview: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/services/preview-controller", () => ({
  previewController: {
    getActiveScope: () => scopeState.current,
    reconnectWebPreview,
    closeWebPreview,
    renameWebPreview,
    reconnectDevicePreview,
    closeDevicePreview,
    renameDevicePreview,
  },
}));

vi.mock("@/components/toast", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { usePreviewOperationStore } from "@/stores/preview-operation-store";
import { usePreviewStore } from "@/stores/preview-store";
import type { PreviewScope } from "@/services/preview-scope";
import { PreviewList } from "./preview-list";

function preview(state: "ready", name?: string): Extract<PreviewSummary, { state: "ready" }>;
function preview(state: "failed", name?: string): Extract<PreviewSummary, { state: "failed" }>;
function preview(
  state: "starting" | "disconnected" | "stopping",
  name?: string,
): Extract<PreviewSummary, { state: "starting" | "disconnected" | "stopping" }>;
function preview(state: PreviewSummary["state"], name = "home.html"): PreviewSummary {
  const common = {
    previewId: "preview-1",
    name,
    source: {
      kind: "static" as const,
      rootPath: "/home/dev/site",
      entryPath: "home.html",
    },
    tunnelProvider: "cloudflare" as const,
    createdAt: 10,
    updatedAt: 20,
  };
  if (state === "ready") {
    return {
      ...common,
      state,
      publicUrl: "https://preview-list.trycloudflare.com/home.html",
    };
  }
  if (state === "failed") return { ...common, state, error: "网页预览连接失败" };
  return { ...common, state };
}

function devicePreview(
  state: "ready",
  name?: string,
): Extract<DevicePreviewSummary, { state: "ready" }>;
function devicePreview(
  state: "disconnected",
  name?: string,
): Extract<DevicePreviewSummary, { state: "disconnected" }>;
function devicePreview(
  state: DevicePreviewSummary["state"],
  name = "iPhone",
): DevicePreviewSummary {
  const common = {
    previewId: "device-preview-1",
    name,
    platform: "ios" as const,
    targetId: "target-1",
    model: "iPhone 17 Pro",
    osVersion: "26.4",
    interactive: true,
    createdAt: 10,
    updatedAt: 20,
  };
  return { ...common, state };
}

function replaceWebSnapshot(
  item: PreviewSummary | readonly PreviewSummary[],
  scope: PreviewScope = activeScope,
): void {
  usePreviewStore.getState().replaceSnapshot(scope, {
    epoch: "web-epoch",
    revision: 1,
    previews: Array.isArray(item) ? [...item] : [item],
  });
}

function replaceDeviceSnapshot(
  item: DevicePreviewSummary | readonly DevicePreviewSummary[],
  scope: PreviewScope = activeScope,
): void {
  useDevicePreviewStore.getState().replaceSnapshot(scope, {
    epoch: "device-epoch",
    revision: 1,
    previews: Array.isArray(item) ? [...item] : [item],
  });
}

function openPreviewMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-slot="preview-row-menu-trigger"]',
  )!;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

function openDevicePreviewMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-slot="device-preview-row-menu-trigger"]',
  )!;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <PreviewList />
    </MemoryRouter>,
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function beginPendingOperation(
  previewKind: "web" | "device",
  kind: "rename" | "reconnect" | "close",
  previewId: string,
  operationId: string,
): void {
  const result = usePreviewOperationStore.getState().begin({
    previewKind,
    kind,
    previewId,
    operationId,
    fingerprint: JSON.stringify([kind, previewId]),
    scope: activeScope,
    startedAt: 100,
  });
  expect(result.status).toBe("applied");
}

function finishPendingOperation(operationId: string): void {
  usePreviewOperationStore.getState().finish(activeScope, operationId);
}

describe("PreviewList", () => {
  beforeEach(() => {
    scopeState.current = activeScope;
    usePreviewStore.getState().clear();
    useDevicePreviewStore.getState().clear();
    usePreviewOperationStore.getState().clear();
    usePreviewStore.getState().activateScope(activeScope);
    useDevicePreviewStore.getState().activateScope(activeScope);
    reconnectWebPreview.mockReset();
    closeWebPreview.mockReset();
    renameWebPreview.mockReset();
    reconnectDevicePreview.mockReset();
    closeDevicePreview.mockReset();
    renameDevicePreview.mockReset();
    toastError.mockReset();
  });

  afterEach(() => cleanup());

  it("is absent when the authoritative scope has no previews", () => {
    renderList();
    expect(document.querySelector('[data-slot="preview-section"]')).not.toBeInTheDocument();
  });

  it("renders a ready device without offering a resource-level reconnect", async () => {
    replaceDeviceSnapshot(devicePreview("ready", "Checkout flow"));
    renderList();

    const metadata = document.querySelector('[data-slot="device-preview-row-device"]');
    expect(metadata).toHaveAttribute("data-device-model", "iPhone 17 Pro");
    expect(metadata).toHaveAttribute("data-os-version", "26.4");
    expect(metadata).toHaveTextContent("iPhone 17 Pro · iOS 26.4");

    openDevicePreviewMenu();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="device-preview-row-close-item"]'),
      ).toBeInTheDocument(),
    );
    expect(
      document.querySelector('[data-slot="device-preview-row-reconnect-item"]'),
    ).not.toBeInTheDocument();
  });

  it("keeps pending close separate from authoritative state until a removed push arrives", async () => {
    const request = deferred<{
      operationId: string;
      previewId: string;
      success: boolean;
    }>();
    const operationId = "web-close-1";
    closeWebPreview.mockImplementationOnce(() => {
      beginPendingOperation("web", "close", "preview-1", operationId);
      return request.promise.finally(() => finishPendingOperation(operationId));
    });
    replaceWebSnapshot(preview("ready"));
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-close-item"]')).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-close-item"]')!);
    fireEvent.click(document.querySelector('[data-slot="preview-close-confirm"]')!);

    await waitFor(() => {
      expect(closeWebPreview).toHaveBeenCalledWith(activeScope, "preview-1");
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-state",
        "ready",
      );
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-operation",
        "close",
      );
    });

    await act(async () => {
      request.resolve({ operationId, previewId: "preview-1", success: true });
      await request.promise;
    });
    expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
      "data-preview-state",
      "ready",
    );

    act(() => {
      usePreviewStore.getState().applyPreviewRemoved(activeScope, "preview-1", "web-epoch", 2);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-section"]')).not.toBeInTheDocument(),
    );
  });

  it("does not roll back an authoritative failed push when close returns a late failure", async () => {
    const request = deferred<{
      operationId: string;
      previewId: string;
      success: boolean;
      error?: string;
    }>();
    const operationId = "web-close-2";
    closeWebPreview.mockImplementationOnce(() => {
      beginPendingOperation("web", "close", "preview-1", operationId);
      return request.promise.finally(() => finishPendingOperation(operationId));
    });
    replaceWebSnapshot(preview("ready"));
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-close-item"]')).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-close-item"]')!);
    fireEvent.click(document.querySelector('[data-slot="preview-close-confirm"]')!);
    await waitFor(() => expect(closeWebPreview).toHaveBeenCalled());

    act(() => {
      usePreviewStore
        .getState()
        .applyPreviewState(
          activeScope,
          { ...preview("failed"), error: "无法关闭预览", updatedAt: 30 },
          "web-epoch",
          2,
        );
    });
    expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
      "data-preview-state",
      "failed",
    );
    expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
      "data-preview-operation",
      "close",
    );

    await act(async () => {
      request.resolve({
        operationId,
        previewId: "preview-1",
        success: false,
        error: "无法关闭预览",
      });
      await request.promise;
    });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-state",
        "failed",
      );
      expect(document.querySelector('[data-slot="preview-row"]')).not.toHaveAttribute(
        "data-preview-operation",
      );
      expect(toastError).toHaveBeenCalledWith("无法关闭预览");
    });
  });

  it("does not roll back an authoritative failed push when reconnect returns a late failure", async () => {
    const request = deferred<{
      operationId: string;
      previewId: string;
      success: boolean;
      error?: string;
    }>();
    const operationId = "web-reconnect-1";
    reconnectWebPreview.mockImplementationOnce(() => {
      beginPendingOperation("web", "reconnect", "preview-1", operationId);
      return request.promise.finally(() => finishPendingOperation(operationId));
    });
    replaceWebSnapshot(preview("disconnected"));
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="preview-row-reconnect-item"]'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-reconnect-item"]')!);

    await waitFor(() => {
      expect(reconnectWebPreview).toHaveBeenCalledWith(activeScope, "preview-1");
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-state",
        "disconnected",
      );
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-operation",
        "reconnect",
      );
    });

    act(() => {
      usePreviewStore
        .getState()
        .applyPreviewState(
          activeScope,
          { ...preview("failed"), error: "无法重新连接网页预览", updatedAt: 30 },
          "web-epoch",
          2,
        );
    });
    await act(async () => {
      request.resolve({
        operationId,
        previewId: "preview-1",
        success: false,
        error: "无法重新连接网页预览",
      });
      await request.promise;
    });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-state",
        "failed",
      );
      expect(document.querySelector('[data-slot="preview-row"]')).not.toHaveAttribute(
        "data-preview-operation",
      );
      expect(toastError).toHaveBeenCalledWith("无法重新连接网页预览");
    });
  });

  it("routes device reconnect and close through the controller without mutating the entity", async () => {
    const reconnectRequest = deferred<{
      operationId: string;
      previewId: string;
      success: boolean;
    }>();
    const closeRequest = deferred<{
      operationId: string;
      previewId: string;
      success: boolean;
    }>();
    const reconnectOperationId = "device-reconnect-1";
    const closeOperationId = "device-close-1";
    reconnectDevicePreview.mockImplementationOnce(() => {
      beginPendingOperation("device", "reconnect", "device-preview-1", reconnectOperationId);
      return reconnectRequest.promise.finally(() => finishPendingOperation(reconnectOperationId));
    });
    closeDevicePreview.mockImplementationOnce(() => {
      beginPendingOperation("device", "close", "device-preview-1", closeOperationId);
      return closeRequest.promise.finally(() => finishPendingOperation(closeOperationId));
    });
    replaceDeviceSnapshot(devicePreview("disconnected"));
    renderList();

    openDevicePreviewMenu();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="device-preview-row-reconnect-item"]'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="device-preview-row-reconnect-item"]')!);
    await waitFor(() => {
      expect(reconnectDevicePreview).toHaveBeenCalledWith(activeScope, "device-preview-1");
      expect(document.querySelector('[data-slot="device-preview-row"]')).toHaveAttribute(
        "data-preview-state",
        "disconnected",
      );
      expect(document.querySelector('[data-slot="device-preview-row"]')).toHaveAttribute(
        "data-preview-operation",
        "reconnect",
      );
    });
    await act(async () => {
      reconnectRequest.resolve({
        operationId: reconnectOperationId,
        previewId: "device-preview-1",
        success: true,
      });
      await reconnectRequest.promise;
    });

    openDevicePreviewMenu();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="device-preview-row-close-item"]'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="device-preview-row-close-item"]')!);
    fireEvent.click(document.querySelector('[data-slot="device-preview-close-confirm"]')!);
    await waitFor(() => {
      expect(closeDevicePreview).toHaveBeenCalledWith(activeScope, "device-preview-1");
      expect(document.querySelector('[data-slot="device-preview-row"]')).toHaveAttribute(
        "data-preview-state",
        "disconnected",
      );
      expect(document.querySelector('[data-slot="device-preview-row"]')).toHaveAttribute(
        "data-preview-operation",
        "close",
      );
    });
    await act(async () => {
      closeRequest.resolve({
        operationId: closeOperationId,
        previewId: "device-preview-1",
        success: true,
      });
      await closeRequest.promise;
    });

    expect(document.querySelector('[data-slot="device-preview-row"]')).toHaveAttribute(
      "data-preview-state",
      "disconnected",
    );
    act(() => {
      useDevicePreviewStore
        .getState()
        .applyPreviewRemoved(activeScope, "device-preview-1", "device-epoch", 2);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-section"]')).not.toBeInTheDocument(),
    );
  });

  it("routes web rename through the controller and waits for authoritative data", async () => {
    const request = deferred<{
      operationId: string;
      previewId: string;
      success: boolean;
    }>();
    const operationId = "web-rename-1";
    renameWebPreview.mockImplementationOnce(() => {
      beginPendingOperation("web", "rename", "preview-1", operationId);
      return request.promise.finally(() => finishPendingOperation(operationId));
    });
    replaceWebSnapshot(preview("ready"));
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-rename-item"]')).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-rename-item"]')!);
    const input = await waitFor(() => {
      const element = document.querySelector<HTMLInputElement>(
        '[data-slot="preview-rename-input"]',
      );
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.change(input, { target: { value: "  Admin preview  " } });
    fireEvent.click(document.querySelector('[data-slot="preview-rename-submit"]')!);

    await waitFor(() => {
      expect(renameWebPreview).toHaveBeenCalledWith(activeScope, "preview-1", "Admin preview");
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-operation",
        "rename",
      );
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveTextContent("home.html");
    });

    act(() => {
      usePreviewStore
        .getState()
        .applyPreviewState(activeScope, preview("ready", "Admin preview"), "web-epoch", 2);
    });
    await act(async () => {
      request.resolve({
        operationId,
        previewId: "preview-1",
        success: true,
      });
      await request.promise;
    });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveTextContent(
        "Admin preview",
      );
      expect(document.querySelector('[data-slot="preview-row"]')).not.toHaveAttribute(
        "data-preview-operation",
      );
    });
  });

  it("routes device rename through the controller and waits for authoritative data", async () => {
    renameDevicePreview.mockResolvedValue({
      operationId: "device-rename-1",
      previewId: "device-preview-1",
      success: true,
    });
    replaceDeviceSnapshot(devicePreview("ready"));
    renderList();

    openDevicePreviewMenu();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="device-preview-row-rename-item"]'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="device-preview-row-rename-item"]')!);
    const input = await waitFor(() => {
      const element = document.querySelector<HTMLInputElement>(
        '[data-slot="preview-rename-input"]',
      );
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.change(input, { target: { value: "Checkout simulator" } });
    fireEvent.click(document.querySelector('[data-slot="preview-rename-submit"]')!);

    await waitFor(() =>
      expect(renameDevicePreview).toHaveBeenCalledWith(
        activeScope,
        "device-preview-1",
        "Checkout simulator",
      ),
    );
    expect(document.querySelector('[data-slot="device-preview-row"]')).toHaveTextContent("iPhone");

    act(() => {
      useDevicePreviewStore
        .getState()
        .applyPreviewState(
          activeScope,
          devicePreview("ready", "Checkout simulator"),
          "device-epoch",
          2,
        );
    });
    expect(document.querySelector('[data-slot="device-preview-row"]')).toHaveTextContent(
      "Checkout simulator",
    );
  });

  it("does not send an A dialog target through the current B scope", async () => {
    const scopeB = Object.freeze({ proxyId: "proxy-b", bindingId: "binding-b-1" });
    replaceWebSnapshot(preview("ready"));
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-close-item"]')).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-close-item"]')!);
    const staleConfirm = document.querySelector('[data-slot="preview-close-confirm"]')!;

    scopeState.current = scopeB;
    fireEvent.click(staleConfirm);
    expect(closeWebPreview).not.toHaveBeenCalled();

    act(() => {
      usePreviewStore.getState().activateScope(scopeB);
      useDevicePreviewStore.getState().activateScope(scopeB);
      replaceWebSnapshot({ ...preview("ready"), name: "B preview" }, scopeB);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-close-dialog"]')).not.toBeInTheDocument(),
    );
  });

  it("closes rename and close dialogs when their authoritative entities are removed", async () => {
    const otherWebPreview = { ...preview("ready", "Other"), previewId: "preview-2" };
    replaceWebSnapshot([preview("ready"), otherWebPreview]);
    replaceDeviceSnapshot(devicePreview("ready"));
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-rename-item"]')).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-rename-item"]')!);
    expect(document.querySelector('[data-slot="preview-rename-dialog"]')).toBeInTheDocument();

    act(() => {
      usePreviewStore.getState().applyPreviewRemoved(activeScope, "preview-1", "web-epoch", 2);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-rename-dialog"]')).not.toBeInTheDocument(),
    );
    expect(renameWebPreview).not.toHaveBeenCalled();

    openDevicePreviewMenu();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="device-preview-row-close-item"]'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="device-preview-row-close-item"]')!);
    expect(document.querySelector('[data-slot="device-preview-close-dialog"]')).toBeInTheDocument();

    act(() => {
      useDevicePreviewStore
        .getState()
        .applyPreviewRemoved(activeScope, "device-preview-1", "device-epoch", 2);
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="device-preview-close-dialog"]'),
      ).not.toBeInTheDocument(),
    );
    expect(closeDevicePreview).not.toHaveBeenCalled();
  });

  it("does not reopen an A1 target for the same preview id after A -> B -> A2", async () => {
    const scopeB = Object.freeze({ proxyId: "proxy-b", bindingId: "binding-b-1" });
    const reboundScope = Object.freeze({ proxyId: "proxy-a", bindingId: "binding-a-2" });
    renameWebPreview.mockResolvedValue({
      operationId: "rename-a2",
      previewId: "preview-1",
      success: true,
    });
    replaceWebSnapshot(preview("ready", "A1 preview"));
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-rename-item"]')).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-rename-item"]')!);
    expect(document.querySelector('[data-slot="preview-rename-input"]')).toHaveValue("A1 preview");

    act(() => {
      scopeState.current = scopeB;
      usePreviewStore.getState().activateScope(scopeB);
      useDevicePreviewStore.getState().activateScope(scopeB);
      scopeState.current = reboundScope;
      usePreviewStore.getState().activateScope(reboundScope);
      useDevicePreviewStore.getState().activateScope(reboundScope);
      replaceWebSnapshot(preview("ready", "A2 preview"), reboundScope);
    });

    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-rename-dialog"]')).not.toBeInTheDocument(),
    );
    expect(renameWebPreview).not.toHaveBeenCalled();

    openPreviewMenu();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-rename-item"]')).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-rename-item"]')!);
    const input = await waitFor(() => {
      const element = document.querySelector<HTMLInputElement>(
        '[data-slot="preview-rename-input"]',
      );
      expect(element).toHaveValue("A2 preview");
      return element!;
    });
    fireEvent.change(input, { target: { value: "A2 renamed" } });
    fireEvent.click(document.querySelector('[data-slot="preview-rename-submit"]')!);

    await waitFor(() =>
      expect(renameWebPreview).toHaveBeenCalledWith(reboundScope, "preview-1", "A2 renamed"),
    );
  });
});
