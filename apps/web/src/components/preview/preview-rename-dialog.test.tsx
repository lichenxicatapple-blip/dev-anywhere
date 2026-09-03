import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewRenameDialog } from "./preview-rename-dialog";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PreviewRenameDialog", () => {
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("keeps the dialog open and does not submit an empty name", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <PreviewRenameDialog
        target={{ targetKey: "web\0proxy-a\0binding-a\0preview-1", name: "Current name" }}
        onOpenChange={onOpenChange}
        onRename={onRename}
      />,
    );

    fireEvent.change(document.querySelector('[data-slot="preview-rename-input"]')!, {
      target: { value: "   " },
    });
    fireEvent.click(document.querySelector('[data-slot="preview-rename-submit"]')!);

    expect(onRename).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("submits the trimmed name and closes after success", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <PreviewRenameDialog
        target={{
          targetKey: "device\0proxy-a\0binding-a\0device-preview-1",
          name: "iPhone",
        }}
        onOpenChange={onOpenChange}
        onRename={onRename}
      />,
    );

    fireEvent.change(document.querySelector('[data-slot="preview-rename-input"]')!, {
      target: { value: "  Checkout flow  " },
    });
    fireEvent.click(document.querySelector('[data-slot="preview-rename-submit"]')!);

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Checkout flow"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a rename failure without closing", async () => {
    const onRename = vi.fn().mockRejectedValue(new Error("rename-failure-sentinel"));
    const onOpenChange = vi.fn();
    render(
      <PreviewRenameDialog
        target={{ targetKey: "web\0proxy-a\0binding-a\0preview-1", name: "Current name" }}
        onOpenChange={onOpenChange}
        onRename={onRename}
      />,
    );

    fireEvent.change(document.querySelector('[data-slot="preview-rename-input"]')!, {
      target: { value: "New name" },
    });
    fireEvent.click(document.querySelector('[data-slot="preview-rename-submit"]')!);

    expect(await screen.findByRole("alert")).toHaveTextContent("rename-failure-sentinel");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("ignores completion from a target that was replaced while submitting", async () => {
    const firstRename = deferred<void>();
    const onRename = vi.fn().mockReturnValueOnce(firstRename.promise);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <PreviewRenameDialog
        target={{ targetKey: "web\0proxy-a\0binding-a-1\0same-id", name: "A1" }}
        onOpenChange={onOpenChange}
        onRename={onRename}
      />,
    );

    fireEvent.change(document.querySelector('[data-slot="preview-rename-input"]')!, {
      target: { value: "A1 renamed" },
    });
    fireEvent.click(document.querySelector('[data-slot="preview-rename-submit"]')!);
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("A1 renamed"));

    rerender(
      <PreviewRenameDialog
        target={{ targetKey: "web\0proxy-a\0binding-a-2\0same-id", name: "A2" }}
        onOpenChange={onOpenChange}
        onRename={onRename}
      />,
    );
    await waitFor(() =>
      expect(document.querySelector('[data-slot="preview-rename-input"]')).toHaveValue("A2"),
    );

    firstRename.reject(new Error("stale-a1-failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="preview-rename-input"]')).toHaveValue("A2");
  });
});
