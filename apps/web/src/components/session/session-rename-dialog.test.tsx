import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRenameDialog } from "./session-rename-dialog";

describe("SessionRenameDialog", () => {
  afterEach(() => cleanup());

  it("does not submit an empty title", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionRenameDialog
        open
        sessionId="s1"
        initialName="~/project"
        onOpenChange={vi.fn()}
        onRename={onRename}
      />,
    );

    const input = screen.getByLabelText("会话标题");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(await screen.findByText("会话标题不能为空")).not.toBeNull();
  });

  it("submits the trimmed title", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <SessionRenameDialog
        open
        sessionId="s1"
        initialName="~/project"
        onOpenChange={onOpenChange}
        onRename={onRename}
      />,
    );

    fireEvent.change(screen.getByLabelText("会话标题"), {
      target: { value: "  Release checklist  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("s1", "Release checklist"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
