import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ToolApprovalCard } from "./tool-approval-card";
import type { ToolApprovalRequest } from "@/stores/chat-store";

afterEach(cleanup);

function makeApproval(overrides: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest {
  return {
    requestId: "tool-1",
    toolName: "Bash",
    input: {
      command:
        "ls -la /Users/catli/MyApps/CyberVita/11m /Users/catli/MyApps/CyberVita/11m/proxy /Users/catli/MyApps/CyberVita/11m/apps",
    },
    status: "pending",
    ...overrides,
  };
}

describe("ToolApprovalCard", () => {
  it("keeps inline approval cards constrained to the same rail as JSON messages", () => {
    const { container } = render(
      <ToolApprovalCard approval={makeApproval()} sessionId="s1" container="inline" />,
    );

    const row = container.querySelector<HTMLElement>('[data-slot="tool-approval-row"]');
    const card = screen.getByRole("region", { name: /工具审批: Bash/ });
    const summary = container.querySelector<HTMLElement>('[data-slot="tool-approval-summary"]');

    expect(row).not.toBeNull();
    expect(summary).not.toBeNull();
    expect(row?.className).toContain("dev-message-rail");
    expect(row?.className).toContain("mx-auto");
    expect(row?.className).toContain("w-full");
    expect(row?.className).toContain("min-w-0");
    expect(card.className).toContain("w-full");
    expect(card.className).toContain("min-w-0");
    expect(card.className).toContain("max-w-full");
    expect(summary?.className).toContain("min-w-0");
    expect(summary?.className).toContain("truncate");
  });
});
