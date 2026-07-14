import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ChatFindBar } from "./chat-find-bar";
import { useChatFindShortcuts } from "./use-chat-find-shortcuts";

function FindShortcutHarness({
  onPrevious,
  onNext,
  openRequest,
}: {
  onPrevious: () => void;
  onNext: () => void;
  openRequest?: number;
}) {
  const [open, setOpen] = useState(false);
  const shortcuts = useChatFindShortcuts({
    open,
    openRequest,
    onOpen: () => setOpen(true),
    onClose: () => setOpen(false),
    onPrevious,
    onNext,
  });

  return (
    <div>
      <button type="button">内容区</button>
      {open ? (
        <ChatFindBar
          query="needle"
          resultIndex={0}
          resultCount={2}
          focusRequest={shortcuts.focusRequest}
          onQueryChange={() => {}}
          onPrevious={onPrevious}
          onNext={onNext}
          onClose={shortcuts.closeFind}
        />
      ) : null}
    </div>
  );
}

describe("useChatFindShortcuts", () => {
  afterEach(() => cleanup());

  it("handles Cmd/Ctrl shortcuts, refocuses an open search, and restores prior focus", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(<FindShortcutHarness onPrevious={onPrevious} onNext={onNext} />);

    const contentButton = screen.getByRole("button", { name: "内容区" });
    contentButton.focus();
    fireEvent.keyDown(window, { key: "f", metaKey: true });

    const findInput = screen.getByRole("searchbox", { name: "查找内容" });
    expect(findInput).toHaveFocus();

    contentButton.focus();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(findInput).toHaveFocus();

    fireEvent.keyDown(window, { key: "g", ctrlKey: true });
    fireEvent.keyDown(window, { key: "g", ctrlKey: true, shiftKey: true });
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("searchbox", { name: "查找内容" })).toBeNull();
    await waitFor(() => expect(contentButton).toHaveFocus());
  });

  it("opens and focuses search when a menu request changes", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <FindShortcutHarness onPrevious={onPrevious} onNext={onNext} openRequest={0} />,
    );

    expect(screen.queryByRole("searchbox", { name: "查找内容" })).toBeNull();
    rerender(<FindShortcutHarness onPrevious={onPrevious} onNext={onNext} openRequest={1} />);

    expect(screen.getByRole("searchbox", { name: "查找内容" })).toHaveFocus();
  });
});
