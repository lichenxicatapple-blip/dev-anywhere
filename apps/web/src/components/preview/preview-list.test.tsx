import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewSummary } from "@dev-anywhere/shared";

const { reconnectWebPreview, closeWebPreview } = vi.hoisted(() => ({
  reconnectWebPreview: vi.fn(),
  closeWebPreview: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { reconnectWebPreview, closeWebPreview },
  wsManagerRef: null,
}));

import { usePreviewStore } from "@/stores/preview-store";
import { PreviewList } from "./preview-list";

function preview(state: PreviewSummary["state"]): PreviewSummary {
  return {
    previewId: "preview-1",
    name: "home.html",
    source: { kind: "static", rootPath: "/home/dev/site", entryPath: "home.html" },
    state,
    tunnelProvider: "cloudflare",
    ...(state === "ready" ? { publicUrl: "https://preview-list.trycloudflare.com/home.html" } : {}),
    createdAt: 10,
    updatedAt: 20,
  };
}

function openPreviewMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-slot="preview-row-menu-trigger"]',
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

describe("PreviewList", () => {
  beforeEach(() => {
    usePreviewStore.getState().clear();
    reconnectWebPreview.mockReset();
    closeWebPreview.mockReset();
  });

  afterEach(() => cleanup());

  it("is absent when the selected Proxy has no previews", () => {
    renderList();
    expect(document.querySelector('[data-slot="preview-section"]')).not.toBeInTheDocument();
  });

  it("keeps a stopping row until the authoritative removed push arrives", async () => {
    usePreviewStore.getState().addStartingPreview(preview("ready"));
    closeWebPreview.mockResolvedValue({ previewId: "preview-1", success: true });
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-row-close-item"]')).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-close-item"]')!);
    expect(document.querySelector('[data-slot="preview-close-dialog"]')).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-slot="preview-close-confirm"]')!);

    await waitFor(() => {
      expect(closeWebPreview).toHaveBeenCalledWith("preview-1");
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-state",
        "stopping",
      );
    });

    usePreviewStore.getState().applyPreviewRemoved("preview-1");
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-section"]')).not.toBeInTheDocument(),
    );
  });

  it("marks a disconnected preview starting after reconnect is accepted", async () => {
    usePreviewStore.getState().addStartingPreview(preview("disconnected"));
    reconnectWebPreview.mockResolvedValue({ previewId: "preview-1", success: true });
    renderList();

    openPreviewMenu();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="preview-row-reconnect-item"]'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector('[data-slot="preview-row-reconnect-item"]')!);

    await waitFor(() => {
      expect(reconnectWebPreview).toHaveBeenCalledWith("preview-1");
      expect(document.querySelector('[data-slot="preview-row"]')).toHaveAttribute(
        "data-preview-state",
        "starting",
      );
    });
  });
});
