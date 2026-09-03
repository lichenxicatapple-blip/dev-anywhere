import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewState, PreviewSummary } from "@dev-anywhere/shared";

const { copyText, toastSuccess, toastError } = vi.hoisted(() => ({
  copyText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/copy-text", () => ({ copyText }));
vi.mock("@/components/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { PreviewRow } from "./preview-row";

function preview(state: "ready"): Extract<PreviewSummary, { state: "ready" }>;
function preview(state: "failed"): Extract<PreviewSummary, { state: "failed" }>;
function preview(
  state: "starting" | "disconnected" | "stopping",
): Extract<PreviewSummary, { state: "starting" | "disconnected" | "stopping" }>;
function preview(state: PreviewState): PreviewSummary {
  const common = {
    previewId: "preview-1",
    name: "localhost:5173",
    source: { kind: "local" as const, url: "http://localhost:5173/admin" },
    tunnelProvider: "cloudflare" as const,
    createdAt: 10,
    updatedAt: 20,
  };
  if (state === "ready") {
    return { ...common, state, publicUrl: "https://preview-row.trycloudflare.com/admin" };
  }
  if (state === "failed") return { ...common, state, error: "preview-error-sentinel" };
  return { ...common, state };
}

function openMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-slot="preview-row-menu-trigger"]',
  )!;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("PreviewRow", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    copyText.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("renders a ready preview as a real external anchor with copy/share/close actions", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, share });
    copyText.mockResolvedValue("clipboard");
    const onClose = vi.fn();

    render(
      <PreviewRow
        preview={preview("ready")}
        onRename={vi.fn()}
        onReconnect={vi.fn()}
        onClose={onClose}
      />,
    );

    const link = document.querySelector('[data-slot="preview-row-open"]')!;
    expect(link).toHaveAttribute("href", "https://preview-row.trycloudflare.com/admin");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    openMenu();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-copy-item"]')).toBeInTheDocument(),
    );
    const shareItem = document.querySelector('[data-slot="preview-row-share-item"]');
    expect(shareItem).toBeInTheDocument();
    fireEvent.click(shareItem!);
    await vi.waitFor(() =>
      expect(share).toHaveBeenCalledWith({
        title: "localhost:5173",
        url: "https://preview-row.trycloudflare.com/admin",
      }),
    );
  });

  it("offers reconnect and close for failed/disconnected previews without an open link", async () => {
    const onReconnect = vi.fn();
    const onClose = vi.fn();
    const failedPreview = preview("failed");
    render(
      <PreviewRow
        preview={failedPreview}
        onRename={vi.fn()}
        onReconnect={onReconnect}
        onClose={onClose}
      />,
    );

    expect(document.querySelector('[data-slot="preview-row-open"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
      "data-preview-state",
      "failed",
    );
    expect(document.querySelector('[data-slot="preview-row-error"]')).toHaveAttribute(
      "title",
      failedPreview.error,
    );

    openMenu();
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-slot="preview-row-reconnect-item"]'),
      ).toBeInTheDocument(),
    );
    const reconnect = document.querySelector('[data-slot="preview-row-reconnect-item"]')!;
    fireEvent.click(reconnect);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("keeps close available while starting and disables every action while stopping", async () => {
    render(
      <PreviewRow
        preview={preview("starting")}
        onRename={vi.fn()}
        onReconnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    openMenu();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-close-item"]')).toBeInTheDocument(),
    );
    expect(
      document.querySelector('[data-slot="preview-row-reconnect-item"]'),
    ).not.toBeInTheDocument();

    cleanup();
    render(
      <PreviewRow
        preview={preview("stopping")}
        onRename={vi.fn()}
        onReconnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-slot="preview-row-menu-trigger"]')).toBeDisabled();
  });

  it("opens rename from the row menu", async () => {
    const onRename = vi.fn();
    render(
      <PreviewRow
        preview={preview("ready")}
        onRename={onRename}
        onReconnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    openMenu();
    const renameItem = await vi.waitFor(() => {
      const item = document.querySelector('[data-slot="preview-row-rename-item"]');
      expect(item).toBeInTheDocument();
      return item!;
    });
    fireEvent.click(renameItem);

    expect(onRename).toHaveBeenCalledOnce();
  });

  it("shows command progress without changing the authoritative preview state", () => {
    render(
      <PreviewRow
        preview={preview("disconnected")}
        pendingOperation="reconnect"
        onRename={vi.fn()}
        onReconnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const row = document.querySelector('[data-slot="preview-row"]');
    expect(row).toHaveAttribute("data-preview-state", "disconnected");
    expect(row).toHaveAttribute("data-preview-operation", "reconnect");
    expect(row).toHaveTextContent("正在重新连接");
    expect(document.querySelector('[data-slot="preview-row-menu-trigger"]')).toBeDisabled();
  });
});
