import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PtyApprovalHint } from "./pty-approval-hint";

describe("PtyApprovalHint", () => {
  afterEach(() => cleanup());

  it("describes a generic input request without offering automatic Enter", () => {
    render(<PtyApprovalHint kind="input" autoYesEnabled={true} onAutoYesChange={() => {}} />);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("等待输入");
    expect(screen.queryByRole("button", { name: "Always yes" })).toBeNull();
    expect(screen.queryByText("等待审批")).toBeNull();
  });

  it("offers a session-local Always yes toggle", () => {
    const changes: boolean[] = [];

    render(
      <PtyApprovalHint
        autoYesEnabled={false}
        onAutoYesChange={(enabled) => changes.push(enabled)}
      />,
    );

    const button = screen.getByRole("button", { name: "Always yes" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);

    expect(changes).toEqual([true]);
  });
});
