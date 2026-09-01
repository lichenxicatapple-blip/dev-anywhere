import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPreviewCapability } from "@dev-anywhere/shared";
import { STORAGE_KEYS } from "@/lib/storage-keys";

const {
  requestWebPreviewCapabilities,
  inspectStaticWebPreview,
  createWebPreview,
  requestDirectoryList,
  toastError,
} = vi.hoisted(() => ({
  requestWebPreviewCapabilities: vi.fn(),
  inspectStaticWebPreview: vi.fn(),
  createWebPreview: vi.fn(),
  requestDirectoryList: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    requestWebPreviewCapabilities,
    inspectStaticWebPreview,
    createWebPreview,
    requestDirectoryList,
  },
  wsManagerRef: null,
}));

vi.mock("@/components/toast", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

import { useFileStore } from "@/stores/file-store";
import { usePreviewStore } from "@/stores/preview-store";
import { CreateWebPreviewDialog } from "./create-web-preview-dialog";

const agentCli = {
  claude: { available: true, command: "/usr/local/bin/claude" },
  codex: { available: true, command: "/usr/local/bin/codex" },
};

const availableCapability = {
  supported: true,
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

function capabilityInfo(webPreview: WebPreviewCapability | null = availableCapability) {
  return {
    homePath: "/home/dev",
    agentCli,
    ...(webPreview ? { webPreview } : {}),
  };
}

function getSlot<T extends Element = HTMLElement>(root: HTMLElement, slot: string): T {
  const element = root.querySelector<T>(`[data-slot="${slot}"]`);
  if (!element) throw new Error(`Missing data-slot: ${slot}`);
  return element;
}

async function waitForCapability(root: HTMLElement, status: string): Promise<void> {
  await waitFor(() => {
    expect(root.querySelector('[data-slot="web-preview-capability-status"]')).toHaveAttribute(
      "data-status",
      status,
    );
  });
}

describe("CreateWebPreviewDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    requestWebPreviewCapabilities.mockReset();
    requestWebPreviewCapabilities.mockResolvedValue(capabilityInfo());
    inspectStaticWebPreview.mockReset();
    createWebPreview.mockReset();
    requestDirectoryList.mockReset();
    requestDirectoryList.mockResolvedValue({ path: "/home/dev", entries: [] });
    toastError.mockReset();
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/home/dev",
      agentCli: null,
    });
    usePreviewStore.getState().clear();
  });

  afterEach(() => cleanup());

  it("creates a starting local preview from a loopback URL without navigating", async () => {
    createWebPreview.mockResolvedValue({
      operationId: "operation-1",
      accepted: true,
      previewId: "preview-1",
    });
    const onOpenChange = vi.fn();
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={onOpenChange} />);

    await waitForCapability(baseElement, "ready");
    fireEvent.change(getSlot<HTMLInputElement>(baseElement, "web-preview-local-url"), {
      target: { value: "http://localhost:5173/admin?tab=users" },
    });
    fireEvent.click(getSlot(baseElement, "create-web-preview-submit"));

    await waitFor(() => {
      expect(createWebPreview).toHaveBeenCalledWith(
        {
          kind: "local",
          url: "http://localhost:5173/admin?tab=users",
        },
        {
          tunnelProvider: "cloudflare",
          operationId: expect.stringMatching(/^preview-operation-cloudflare-/),
        },
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(usePreviewStore.getState().previews).toEqual([
      expect.objectContaining({
        previewId: "preview-1",
        name: "localhost:5173/admin",
        state: "starting",
        tunnelProvider: "cloudflare",
      }),
    ]);
  });

  it("rejects non-loopback and HTTPS addresses before sending a create request", async () => {
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(requestWebPreviewCapabilities).toHaveBeenCalled());

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
      rootPath: "/home/dev/site",
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
      expect(inspectStaticWebPreview).toHaveBeenCalledWith("/home/dev/site/");
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

  it("selects and persists cpolar, sends it, and records it on the optimistic preview", async () => {
    requestWebPreviewCapabilities.mockResolvedValue(capabilityInfo(bothProvidersAvailable));
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
        { kind: "local", url: "http://localhost:4173" },
        {
          tunnelProvider: "cpolar",
          operationId: expect.stringMatching(/^preview-operation-cpolar-/),
        },
      );
    });
    expect(usePreviewStore.getState().previews).toEqual([
      expect.objectContaining({ previewId: "preview-cpolar", tunnelProvider: "cpolar" }),
    ]);
  });

  it("restores the last provider selection from storage", async () => {
    localStorage.setItem(STORAGE_KEYS.webPreviewTunnelProvider, "cpolar");
    requestWebPreviewCapabilities.mockResolvedValue(capabilityInfo(bothProvidersAvailable));
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitForCapability(baseElement, "ready");
    expect(getSlot(baseElement, "web-preview-tunnel-provider-field")).toHaveAttribute(
      "data-provider",
      "cpolar",
    );
  });

  it("automatically selects the available provider when the preferred one is missing", async () => {
    requestWebPreviewCapabilities.mockResolvedValue(
      capabilityInfo({
        supported: true,
        cloudflared: { available: false },
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
      rootPath: "/home/dev/site",
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
      expect(inspectStaticWebPreview).toHaveBeenCalledWith("/home/dev/site/");
      expect(getSlot(baseElement, "web-preview-static-inspection")).toHaveAttribute(
        "data-entry-path",
        "index.html",
      );
    });
  });

  it("distinguishes an unsupported web preview feature from a missing executable", async () => {
    requestWebPreviewCapabilities.mockResolvedValue(capabilityInfo(null));
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitForCapability(baseElement, "unsupported");
    expect(getSlot(baseElement, "create-web-preview-submit")).toBeDisabled();
  });

  it("rechecks cloudflared with a refreshed login-shell PATH", async () => {
    requestWebPreviewCapabilities
      .mockResolvedValueOnce(
        capabilityInfo({
          supported: true,
          cloudflared: { available: false, error: "cloudflared-missing-sentinel" },
          cpolar: { available: false },
        }),
      )
      .mockResolvedValueOnce(capabilityInfo());
    const { baseElement } = render(<CreateWebPreviewDialog open onOpenChange={vi.fn()} />);

    await waitForCapability(baseElement, "missing");
    fireEvent.click(getSlot(baseElement, "web-preview-capability-retry"));

    await waitFor(() => {
      expect(requestWebPreviewCapabilities).toHaveBeenNthCalledWith(1, false);
      expect(requestWebPreviewCapabilities).toHaveBeenNthCalledWith(2, true);
    });
    await waitForCapability(baseElement, "ready");
  });

  it("shows detected candidate paths and cross-platform installation guidance", async () => {
    requestWebPreviewCapabilities.mockResolvedValue(
      capabilityInfo({
        supported: true,
        cloudflared: {
          available: false,
          error: "cloudflared-failure-sentinel",
          suggestions: ["/usr/local/bin/cloudflared"],
        },
        cpolar: { available: false },
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

  it("reuses the operation id when an uncertain create attempt is retried", async () => {
    let rejectFirstAttempt: (error: Error) => void = () => undefined;
    const firstAttempt = new Promise((_, reject) => {
      rejectFirstAttempt = reject;
    });
    createWebPreview.mockReturnValueOnce(firstAttempt).mockResolvedValueOnce({
      operationId: "operation-retried",
      accepted: true,
      previewId: "preview-retried",
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

    expect(createWebPreview.mock.calls[0]?.[1]?.operationId).toBeTruthy();
    expect(createWebPreview.mock.calls[1]?.[1]?.operationId).toBe(
      createWebPreview.mock.calls[0]?.[1]?.operationId,
    );
  });
});
