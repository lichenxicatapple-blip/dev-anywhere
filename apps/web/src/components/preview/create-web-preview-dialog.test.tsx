import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewScope, PreviewSummary, WebPreviewCapability } from "@dev-anywhere/shared";
import { STORAGE_KEYS } from "@/lib/storage-keys";

const {
  scopeState,
  relayClient,
  requestWebPreviewCapability,
  inspectStaticWebPreview,
  createWebPreview,
  getActiveScope,
  isActive,
  requestDirectoryList,
  toastError,
} = vi.hoisted(() => {
  const requestWebPreviewCapability = vi.fn();
  const requestDirectoryList = vi.fn();
  return {
    scopeState: {
      current: Object.freeze({ proxyId: "proxy-a", bindingId: "binding-a-1" }) as PreviewScope,
    },
    relayClient: { requestDirectoryList },
    requestWebPreviewCapability,
    inspectStaticWebPreview: vi.fn(),
    createWebPreview: vi.fn(),
    getActiveScope: vi.fn(),
    isActive: vi.fn(),
    requestDirectoryList,
    toastError: vi.fn(),
  };
});

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: relayClient,
  wsManagerRef: null,
}));

vi.mock("@/services/preview-controller", () => ({
  previewController: {
    getActiveScope,
    isActive,
    requestWebPreviewCapability,
    inspectStaticWebPreview,
    createWebPreview,
  },
}));

vi.mock("@/components/toast", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

import { useFileStore } from "@/stores/file-store";
import { useAppStore } from "@/stores/app-store";
import { selectWebPreviews, usePreviewStore } from "@/stores/preview-store";
import { CreateWebPreviewDialog } from "./create-web-preview-dialog";

const availableCapability = {
  cloudflared: {
    available: true,
    command: "/opt/homebrew/bin/cloudflared",
    version: "cloudflared version 2026.8.0",
  },
  cpolar: { available: false, error: "cpolar-missing-sentinel" },
} satisfies WebPreviewCapability;

const bothProvidersAvailable = {
  ...availableCapability,
  cpolar: {
    available: true,
    command: "/usr/local/bin/cpolar",
    version: "cpolar 3.3.18",
  },
} satisfies WebPreviewCapability;

function capabilityResult(capability: WebPreviewCapability = availableCapability) {
  return { success: true as const, capability };
}

function resolveCapability(capability: WebPreviewCapability = availableCapability) {
  return async (scope: PreviewScope) => {
    usePreviewStore.getState().setCapabilityLoading(scope);
    usePreviewStore.getState().setCapability(scope, capability);
    return capabilityResult(capability);
  };
}

function getSlot<T extends Element = HTMLElement>(root: HTMLElement, slot: string): T {
  const element = root.querySelector<T>(`[data-slot="${slot}"]`);
  if (!element) throw new Error(`Missing data-slot: ${slot}`);
  return element;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCapability(root: HTMLElement, status: string): Promise<void> {
  await waitFor(() => {
    expect(root.querySelector('[data-slot="web-preview-capability-status"]')).toHaveAttribute(
      "data-status",
      status,
    );
  });
}

function sameScope(left: typeof scopeState.current, right: typeof scopeState.current): boolean {
  return left.proxyId === right.proxyId && left.bindingId === right.bindingId;
}

function createdPreview(
  previewId: string,
  name: string,
  tunnelProvider: "cloudflare" | "cpolar" = "cloudflare",
): PreviewSummary {
  return {
    previewId,
    name,
    source: { kind: "local", url: "http://localhost:5173/admin?tab=users" },
    state: "starting",
    tunnelProvider,
    createdAt: 10,
    updatedAt: 10,
  };
}

function activateScope(proxyId: string, bindingId: string): typeof scopeState.current {
  const scope = Object.freeze({ proxyId, bindingId });
  scopeState.current = scope;
  useAppStore.getState().setProxy(proxyId, `Machine ${proxyId}`);
  usePreviewStore.getState().activateScope(scope);
  usePreviewStore.getState().replaceSnapshot(scope, {
    epoch: `${bindingId}-epoch`,
    revision: 0,
    previews: [],
  });
  return scope;
}

describe("CreateWebPreviewDialog", () => {
  beforeEach(() => {
    const scope = activateScope("proxy-a", "binding-a-1");
    localStorage.clear();
    requestWebPreviewCapability.mockReset();
    requestWebPreviewCapability.mockImplementation(resolveCapability());
    inspectStaticWebPreview.mockReset();
    createWebPreview.mockReset();
    requestDirectoryList.mockReset();
    requestDirectoryList.mockResolvedValue({ path: "/home/dev", entries: [] });
    getActiveScope.mockReset();
    getActiveScope.mockImplementation(() => scopeState.current);
    isActive.mockReset();
    isActive.mockImplementation(
      (candidateRelay, candidateScope) =>
        candidateRelay === relayClient && sameScope(candidateScope, scopeState.current),
    );
    toastError.mockReset();
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: null,
    });
    expect(usePreviewStore.getState().authoritative?.scope).toEqual(scope);
  });

  afterEach(() => cleanup());

  it("waits for an authoritative update after a scoped local create ACK", async () => {
    createWebPreview.mockResolvedValue({
      operationId: "operation-1",
      accepted: true,
      previewId: "preview-1",
    });
    const onOpenChange = vi.fn();
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={onOpenChange} />);

    await waitForCapability(baseElement, "ready");
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-name"), {
      target: { value: "  Admin preview  " },
    });
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
      target: { value: "http://localhost:5173/admin?tab=users" },
    });
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));

    await waitFor(() => {
      expect(createWebPreview).toHaveBeenCalledWith(
        scopeState.current,
        {
          kind: "local",
          url: "http://localhost:5173/admin?tab=users",
        },
        {
          tunnelProvider: "cloudflare",
          operationId: expect.stringMatching(/^preview-operation-cloudflare-/),
          name: "Admin preview",
        },
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(selectWebPreviews(usePreviewStore.getState())).toEqual([]);

    act(() => {
      usePreviewStore
        .getState()
        .applyPreviewState(
          scopeState.current,
          createdPreview("preview-1", "Admin preview"),
          "binding-a-1-epoch",
          1,
        );
    });
    expect(selectWebPreviews(usePreviewStore.getState())).toEqual([
      expect.objectContaining({ previewId: "preview-1", name: "Admin preview" }),
    ]);
  });

  it("rejects non-loopback and HTTPS addresses before sending a create request", async () => {
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(requestWebPreviewCapability).toHaveBeenCalled());

    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
      target: { value: "https://example.com" },
    });
    await waitFor(() =>
      expect(
        baseElement.querySelector('[data-slot="web-preview-local-url-error"]'),
      ).toBeInTheDocument(),
    );
    expect(getSlot(baseElement, "create-web-preview-submit")).toBeDisabled();
    expect(createWebPreview).not.toHaveBeenCalled();
  });

  it("inspects a folder and asks for an entry only when multiple HTML files lack index.html", async () => {
    inspectStaticWebPreview.mockResolvedValue({
      success: true,
      htmlEntries: ["home.html", "pages/docs.html"],
    });
    createWebPreview.mockResolvedValue({
      operationId: "operation-2",
      accepted: true,
      previewId: "preview-static",
    });
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
    await waitForCapability(baseElement, "ready");

    fireEvent.click(getSlot(baseElement, "web-preview-source-static"));
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-static-path"), {
      target: { value: "/home/dev/site/" },
    });

    await waitFor(() => {
      expect(inspectStaticWebPreview).toHaveBeenCalledWith(scopeState.current, "/home/dev/site/", {
        signal: expect.any(AbortSignal),
      });
      expect(getSlot(baseElement, "web-preview-static-inspection")).toHaveAttribute(
        "data-status",
        "choose-entry",
      );
    });
    expect(getSlot(baseElement, "create-web-preview-submit")).toBeDisabled();

    fireEvent.click(getSlot(baseElement, "web-preview-entry-select"));
    fireEvent.click(baseElement.querySelector('[data-entry-path="pages/docs.html"]')!);
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));

    await waitFor(() => {
      expect(createWebPreview).toHaveBeenCalledWith(
        scopeState.current,
        {
          kind: "static",
          path: "/home/dev/site/",
          entryPath: "pages/docs.html",
        },
        {
          tunnelProvider: "cloudflare",
          operationId: expect.stringMatching(/^preview-operation-cloudflare-/),
        },
      );
    });
  });

  it("does not use the first HTML entry as an implicit selection", async () => {
    inspectStaticWebPreview.mockResolvedValue({
      success: true,
      htmlEntries: ["only.html"],
    });
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
    await waitForCapability(baseElement, "ready");

    fireEvent.click(getSlot(baseElement, "web-preview-source-static"));
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-static-path"), {
      target: { value: "/home/dev/site/" },
    });

    await waitFor(() => expect(inspectStaticWebPreview).toHaveBeenCalledOnce());
    expect(getSlot(baseElement, "create-web-preview-submit")).toBeDisabled();
    expect(createWebPreview).not.toHaveBeenCalled();
  });

  it("selects and persists cpolar without synthesizing a preview entity from its ACK", async () => {
    requestWebPreviewCapability.mockImplementation(resolveCapability(bothProvidersAvailable));
    createWebPreview.mockResolvedValue({
      operationId: "operation-cpolar",
      accepted: true,
      previewId: "preview-cpolar",
    });
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
    await waitForCapability(baseElement, "ready");

    fireEvent.click(getSlot(baseElement, "web-preview-tunnel-provider-select"));
    fireEvent.click(
      baseElement.querySelector(
        '[data-slot="web-preview-tunnel-provider-option"][data-provider="cpolar"]',
      )!,
    );
    await waitFor(() => {
      expect(getSlot(baseElement, "web-preview-tunnel-provider-select")).toHaveAttribute(
        "data-provider",
        "cpolar",
      );
      expect(getSlot(baseElement, "web-preview-capability-status")).toHaveAttribute(
        "data-provider",
        "cpolar",
      );
    });
    expect(localStorage.getItem(STORAGE_KEYS.webPreviewTunnelProvider)).toBe("cpolar");

    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
      target: { value: "http://localhost:4173" },
    });
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));

    await waitFor(() => {
      expect(createWebPreview).toHaveBeenCalledWith(
        scopeState.current,
        { kind: "local", url: "http://localhost:4173" },
        {
          tunnelProvider: "cpolar",
          operationId: expect.stringMatching(/^preview-operation-cpolar-/),
        },
      );
    });
    expect(selectWebPreviews(usePreviewStore.getState())).toEqual([]);
  });

  it("restores the last provider selection from storage", async () => {
    localStorage.setItem(STORAGE_KEYS.webPreviewTunnelProvider, "cpolar");
    requestWebPreviewCapability.mockImplementation(resolveCapability(bothProvidersAvailable));
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitForCapability(baseElement, "ready");
    expect(getSlot(baseElement, "web-preview-tunnel-provider-field")).toHaveAttribute(
      "data-provider",
      "cpolar",
    );
  });

  it("automatically selects the available provider when the preferred one is missing", async () => {
    requestWebPreviewCapability.mockImplementation(
      resolveCapability({
        cloudflared: { available: false, error: "Cloudflare Tunnel not found" },
        cpolar: { available: true, command: "/usr/local/bin/cpolar" },
      }),
    );
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitForCapability(baseElement, "ready");
    expect(getSlot(baseElement, "web-preview-capability-status")).toHaveAttribute(
      "data-provider",
      "cpolar",
    );
    expect(localStorage.getItem(STORAGE_KEYS.webPreviewTunnelProvider)).toBe("cpolar");
  });

  it("disables creation when the selected provider executable is missing", async () => {
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
    await waitForCapability(baseElement, "ready");

    fireEvent.click(getSlot(baseElement, "web-preview-tunnel-provider-select"));
    fireEvent.click(
      baseElement.querySelector(
        '[data-slot="web-preview-tunnel-provider-option"][data-provider="cpolar"]',
      )!,
    );
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
      target: { value: "http://localhost:3000" },
    });

    await waitForCapability(baseElement, "missing");
    expect(getSlot(baseElement, "web-preview-capability-status")).toHaveAttribute(
      "data-provider",
      "cpolar",
    );
    expect(getSlot(baseElement, "create-web-preview-submit")).toBeDisabled();
    expect(createWebPreview).not.toHaveBeenCalled();
  });

  it("navigates into a folder and inspects it only after choosing the current folder", async () => {
    useFileStore.setState({
      tree: new Map([
        ["/home/dev", [{ name: "site", isDir: true }]],
        ["/home/dev/site", [{ name: "index.html", isDir: false }]],
      ]),
      cwd: "",
      homePath: "/home/dev",
      agentCli: null,
    });
    inspectStaticWebPreview.mockResolvedValue({
      success: true,
      entryPath: "index.html",
      htmlEntries: ["index.html"],
    });
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
    await waitForCapability(baseElement, "ready");

    fireEvent.click(getSlot(baseElement, "web-preview-source-static"));
    fireEvent.focus(getSlot(baseElement, "web-preview-static-path"));
    fireEvent.click(baseElement.querySelector('[data-slot="file-entry"][data-entry-name="site"]')!);
    expect(inspectStaticWebPreview).not.toHaveBeenCalled();
    fireEvent.click(getSlot(baseElement, "select-current-directory"));

    await waitFor(() => {
      expect(inspectStaticWebPreview).toHaveBeenCalledWith(scopeState.current, "/home/dev/site/", {
        signal: expect.any(AbortSignal),
      });
      expect(getSlot(baseElement, "web-preview-static-inspection")).toHaveAttribute(
        "data-entry-path",
        "index.html",
      );
    });
  });

  it("rechecks cloudflared with a refreshed login-shell PATH", async () => {
    requestWebPreviewCapability
      .mockImplementationOnce(
        resolveCapability({
          cloudflared: { available: false, error: "cloudflared-missing-sentinel" },
          cpolar: { available: false, error: "Cpolar not found" },
        }),
      )
      .mockImplementationOnce(resolveCapability());
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitForCapability(baseElement, "missing");
    fireEvent.click(getSlot(baseElement, "web-preview-capability-retry"));

    await waitFor(() => {
      expect(requestWebPreviewCapability).toHaveBeenNthCalledWith(1, scopeState.current, false, {
        signal: expect.any(AbortSignal),
      });
      expect(requestWebPreviewCapability).toHaveBeenNthCalledWith(2, scopeState.current, true, {
        signal: expect.any(AbortSignal),
      });
    });
    await waitForCapability(baseElement, "ready");
  });

  it("renders the controller-owned capability failure", async () => {
    requestWebPreviewCapability.mockImplementationOnce(async (scope: PreviewScope) => {
      usePreviewStore.getState().setCapabilityLoading(scope);
      usePreviewStore.getState().setCapabilityError(scope, "capability detection failed");
      return { success: false as const, error: "capability detection failed" };
    });

    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitForCapability(baseElement, "error");
    expect(getSlot(baseElement, "web-preview-capability-status")).toHaveTextContent(
      "capability detection failed",
    );
  });

  it("shows detected candidate paths and cross-platform installation guidance", async () => {
    requestWebPreviewCapability.mockImplementation(
      resolveCapability({
        cloudflared: {
          available: false,
          error: "cloudflared-failure-sentinel",
          suggestions: ["/usr/local/bin/cloudflared"],
        },
        cpolar: { available: false, error: "Cpolar not found" },
      }),
    );
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitForCapability(baseElement, "missing");
    expect(
      baseElement.querySelector(
        '[data-slot="web-preview-cloudflared-suggestion"][data-path="/usr/local/bin/cloudflared"]',
      ),
    ).toBeInTheDocument();
    expect(getSlot(baseElement, "web-preview-cloudflared-install-link")).toHaveAttribute(
      "href",
      "https://developers.cloudflare.com/tunnel/downloads/",
    );
  });

  it("drops a capability result that arrives after the dialog closes", async () => {
    const capabilityRequest = deferred<ReturnType<typeof capabilityResult>>();
    requestWebPreviewCapability.mockImplementationOnce(
      async (scope: PreviewScope, _refreshPath: boolean, options: { signal?: AbortSignal }) => {
        usePreviewStore.getState().setCapabilityLoading(scope);
        const result = await capabilityRequest.promise;
        if (!options?.signal?.aborted) {
          usePreviewStore.getState().setCapability(scope, result.capability);
        }
        return result;
      },
    );
    useFileStore.setState({ homePath: "/current-home" });
    const rendered = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitFor(() => expect(requestWebPreviewCapability).toHaveBeenCalledTimes(1));
    const signal = requestWebPreviewCapability.mock.calls[0]?.[2]?.signal as
      | AbortSignal
      | undefined;
    rendered.rerender(<CreateWebPreviewDialog open={false} onOpenChange={vi.fn()} />);
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      capabilityRequest.resolve(capabilityResult(bothProvidersAvailable));
      await capabilityRequest.promise;
    });

    expect(useFileStore.getState().homePath).toBe("/current-home");
    expect(usePreviewStore.getState().capability).toBeNull();
  });

  it("drops a static inspection that arrives after the same Proxy is rebound", async () => {
    const inspectionRequest = deferred<{
      success: boolean;
      entryPath: string;
      htmlEntries: string[];
    }>();
    inspectStaticWebPreview.mockReturnValueOnce(inspectionRequest.promise);
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
    await waitForCapability(baseElement, "ready");
    fireEvent.click(getSlot(baseElement, "web-preview-source-static"));
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-static-path"), {
      target: { value: "/home/dev/old-site/" },
    });
    await waitFor(() => expect(inspectStaticWebPreview).toHaveBeenCalledTimes(1));

    activateScope("proxy-a", "binding-a-2");
    await act(async () => {
      inspectionRequest.resolve({
        success: true,
        entryPath: "stale.html",
        htmlEntries: ["stale.html"],
      });
      await inspectionRequest.promise;
    });

    expect(
      baseElement.querySelector('[data-slot="web-preview-static-inspection"]'),
    ).not.toHaveAttribute("data-entry-path", "stale.html");
  });

  it("reuses the operation id when a binding change makes the create result uncertain", async () => {
    const createRequest = deferred<{
      operationId: string;
      accepted: boolean;
      previewId: string;
    }>();
    createWebPreview.mockReturnValueOnce(createRequest.promise).mockResolvedValueOnce({
      operationId: "operation-retried",
      accepted: false,
      error: "already handled",
    });
    const onOpenChange = vi.fn();
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={onOpenChange} />);
    await waitForCapability(baseElement, "ready");
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
      target: { value: "http://localhost:5173" },
    });
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));
    await waitFor(() => expect(createWebPreview).toHaveBeenCalledTimes(1));

    const oldScope = createWebPreview.mock.calls[0]?.[0];
    const operationId = createWebPreview.mock.calls[0]?.[2]?.operationId;
    expect(oldScope).toEqual({ proxyId: "proxy-a", bindingId: "binding-a-1" });
    expect(operationId).toMatch(/^preview-operation-cloudflare-/);
    activateScope("proxy-a", "binding-a-2");

    await act(async () => {
      createRequest.reject(new Error("connection interrupted"));
      await createRequest.promise.catch(() => undefined);
    });
    await waitForCapability(baseElement, "ready");
    await waitFor(() => expect(getSlot(baseElement, "create-web-preview-submit")).toBeEnabled());
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));
    await waitFor(() => expect(createWebPreview).toHaveBeenCalledTimes(2));

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(createWebPreview.mock.calls[1]?.[0]).toEqual({
      proxyId: "proxy-a",
      bindingId: "binding-a-2",
    });
    expect(createWebPreview.mock.calls[1]?.[2]?.operationId).toBe(operationId);
  });

  it("retains an uncertain operation id and clears it after every definitive result", async () => {
    let rejectFirstAttempt: (error: Error) => void = () => undefined;
    const firstAttempt = new Promise((_, reject) => {
      rejectFirstAttempt = reject;
    });
    createWebPreview
      .mockReturnValueOnce(firstAttempt)
      .mockResolvedValueOnce({
        operationId: "operation-retried",
        accepted: true,
        previewId: "preview-retried",
      })
      .mockResolvedValueOnce({
        operationId: "operation-rejected-one",
        accepted: false,
        error: "rejected-one",
      })
      .mockResolvedValueOnce({
        operationId: "operation-rejected-two",
        accepted: false,
        error: "rejected-two",
      });
    const onOpenChange = vi.fn();
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={onOpenChange} />);
    await waitForCapability(baseElement, "ready");
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
      target: { value: "http://localhost:4173" },
    });

    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));
    expect(getSlot(baseElement, "web-preview-local-url")).toBeDisabled();
    expect(getSlot(baseElement, "web-preview-source-local")).toBeDisabled();
    expect(getSlot(baseElement, "create-web-preview-cancel")).toBeDisabled();
    expect(
      baseElement.querySelector('[data-slot="dialog-close"], [data-slot="sheet-close"]'),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    rejectFirstAttempt(new Error("preview-create-failure"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("preview-create-failure"));
    await waitFor(() => expect(getSlot(baseElement, "create-web-preview-submit")).toBeEnabled());
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));
    await waitFor(() => expect(createWebPreview).toHaveBeenCalledTimes(2));

    expect(createWebPreview.mock.calls[0]?.[2]?.operationId).toBeTruthy();
    expect(createWebPreview.mock.calls[1]?.[2]?.operationId).toBe(
      createWebPreview.mock.calls[0]?.[2]?.operationId,
    );

    await waitFor(() => expect(getSlot(baseElement, "create-web-preview-submit")).toBeEnabled());
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));
    await waitFor(() => expect(createWebPreview).toHaveBeenCalledTimes(3));
    expect(createWebPreview.mock.calls[2]?.[2]?.operationId).not.toBe(
      createWebPreview.mock.calls[1]?.[2]?.operationId,
    );

    await waitFor(() => expect(getSlot(baseElement, "create-web-preview-submit")).toBeEnabled());
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));
    await waitFor(() => expect(createWebPreview).toHaveBeenCalledTimes(4));
    expect(createWebPreview.mock.calls[3]?.[2]?.operationId).not.toBe(
      createWebPreview.mock.calls[2]?.[2]?.operationId,
    );
  });

  it.each(["source", "provider", "name"] as const)(
    "starts a new operation after the web %s fingerprint changes",
    async (field) => {
      requestWebPreviewCapability.mockImplementation(resolveCapability(bothProvidersAvailable));
      createWebPreview.mockRejectedValueOnce(new Error("uncertain")).mockResolvedValueOnce({
        operationId: "operation-rejected",
        accepted: false,
        error: "rejected",
      });
      const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
      await waitForCapability(baseElement, "ready");
      fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
        target: { value: "http://localhost:4173" },
      });
      fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("uncertain"));
      await waitFor(() => expect(getSlot(baseElement, "create-web-preview-submit")).toBeEnabled());

      if (field === "source") {
        fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
          target: { value: "http://localhost:5174" },
        });
      } else if (field === "name") {
        fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-name"), {
          target: { value: "Changed name" },
        });
      } else {
        fireEvent.click(getSlot(baseElement, "web-preview-tunnel-provider-select"));
        fireEvent.click(
          baseElement.querySelector(
            '[data-slot="web-preview-tunnel-provider-option"][data-provider="cpolar"]',
          )!,
        );
        await waitFor(() =>
          expect(getSlot(baseElement, "web-preview-tunnel-provider-select")).toHaveAttribute(
            "data-provider",
            "cpolar",
          ),
        );
      }

      fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));
      await waitFor(() => expect(createWebPreview).toHaveBeenCalledTimes(2));
      expect(createWebPreview.mock.calls[1]?.[2]?.operationId).not.toBe(
        createWebPreview.mock.calls[0]?.[2]?.operationId,
      );
    },
  );
});
