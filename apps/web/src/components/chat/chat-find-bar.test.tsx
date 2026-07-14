import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFindBar, getFindResultLabel } from "./chat-find-bar";

describe("ChatFindBar", () => {
  afterEach(() => cleanup());

  it("navigates with Enter, Shift+Enter, and the icon buttons", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const onClose = vi.fn();

    render(
      <ChatFindBar
        query="needle"
        resultIndex={1}
        resultCount={3}
        onQueryChange={vi.fn()}
        onPrevious={onPrevious}
        onNext={onNext}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    const input = screen.getByRole("searchbox", { name: "查找内容" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "下一个匹配项" }));
    fireEvent.click(screen.getByRole("button", { name: "上一个匹配项" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭查找" }));

    expect(onNext).toHaveBeenCalledTimes(2);
    expect(onPrevious).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports loading and empty result states without an indeterminate animation", () => {
    const { rerender } = render(
      <ChatFindBar
        query="needle"
        resultIndex={-1}
        resultCount={0}
        loading
        onQueryChange={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("搜索中")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();

    rerender(
      <ChatFindBar
        query="needle"
        resultIndex={-1}
        resultCount={0}
        onQueryChange={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("无结果")).toBeInTheDocument();
  });
});

describe("getFindResultLabel", () => {
  it("marks partial counts while older history is still loading", () => {
    expect(
      getFindResultLabel({ query: "needle", resultIndex: 0, resultCount: 4, loading: true }),
    ).toBe("1 / 4+");
  });
});
