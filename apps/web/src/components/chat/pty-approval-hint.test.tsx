import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PtyApprovalHint } from "./pty-approval-hint";

describe("PtyApprovalHint", () => {
  afterEach(() => cleanup());

  it("uses the same warning rhythm classes as the status light", () => {
    const { container } = render(
      <PtyApprovalHint autoYesEnabled={false} onAutoYesChange={() => undefined} />,
    );

    const hint = screen.getByRole("status", { name: "等待审批" });
    expect(hint.className).toContain("dev-status-line-waiting_approval");
    expect(container.querySelector(".dev-status-line-sweep-waiting")).not.toBeNull();
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
